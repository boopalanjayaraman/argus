"""Orchestrator + independent sub-agents (user-directed, supersedes the
'single coordinator, tools not personas' note in PRD-07 for this layer).

Boundaries:
- Planner/Orchestrator: routes evidence events to sub-agents, runs them in
  parallel, owns the shared InspectionContext and its event log. It never
  analyses media itself and never issues verdicts.
- VideoAgent: video segments only. ImageAgent: photographs only.
  PointCloudAgent: PLY/PCD chunks only (geometry vs CAD reference).
  ReportAgent: aggregates findings into the deviation/dossier payload only.
Each sub-agent accepts only its own media type, works independently, and logs
every outcome (started/completed/failed/skipped) under the same sessionId.
Verdicts still come from coordinator.evaluate_rule — agents produce
observations, the deterministic gate judges.
"""
from __future__ import annotations
import asyncio
import json
import os
import time
import urllib.request
from dataclasses import dataclass, field

import coordinator
import geometry
import meta_adapter


MODEL_CALL_THREADS = int(os.environ.get("MODEL_CALL_THREADS", "32"))


def use_wide_executor() -> None:
    """Model and agent calls are network-bound and run via asyncio.to_thread,
    whose default pool is min(32, CPUs + 4) — about 5 threads on a 1-2 vCPU
    container, which queued a photo's rule checks 5 at a time. Give the
    running loop a pool sized for I/O instead (MODEL_CALL_THREADS)."""
    import concurrent.futures
    asyncio.get_running_loop().set_default_executor(
        concurrent.futures.ThreadPoolExecutor(max_workers=MODEL_CALL_THREADS, thread_name_prefix="model-call"))


@dataclass
class InspectionContext:
    session_id: str
    log: list[dict] = field(default_factory=list)

    def record(self, agent: str, event: str, detail: str = "") -> None:
        self.log.append({"sessionId": self.session_id, "agent": agent, "event": event,
                         "detail": detail, "at": time.time()})
        try:
            import cloud_logging
            cloud_logging.info(f"agent {event}", service=agent, sessionId=self.session_id, detail=detail)
        except Exception:
            pass


class SubAgent:
    name = "agent"
    media_types: set[str] = set()

    def accepts(self, evidence: dict) -> bool:
        return evidence.get("mediaType") in self.media_types

    async def run(self, ctx: InspectionContext, evidence: dict, rule: dict) -> dict:
        raise NotImplementedError


class VideoAgent(SubAgent):
    """Tier 1 only: fast screening of many segments. Never pays flagship
    cost per segment; flagged segments surface via `candidate` for a later
    photo/review pass, not by escalating video itself."""
    name = "video-agent"
    media_types = {"video"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        result = await asyncio.to_thread(meta_adapter.screen_visual, resolve_evidence_file(evidence), rule, "video")
        obs = {"kind": "visual", "source": "video", "tier": "screen", "ruleId": rule.get("ruleId"), "evidenceId": evidence.get("evidenceId"), "eventId": evidence.get("eventId"), "lookFor": {"features": rule.get("features", []), "acceptanceQuote": rule.get("quote")}, **result}
        ctx.record(self.name, "completed" if result.get("status") != "unavailable" else "unavailable", evidence.get("eventId", ""))
        return obs


class ImageAgent(SubAgent):
    """Tiered: Tier 1 screens every photo; Tier 2 (flagship) reviews only
    flagged/high-stakes items per meta_adapter.needs_review. The review is
    an additional observation, never a replacement verdict."""
    name = "image-agent"
    media_types = {"photo"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        screen = await asyncio.to_thread(meta_adapter.screen_visual, resolve_evidence_file(evidence), rule, "photo")
        obs = {"kind": "visual", "source": "photo", "tier": "screen", "ruleId": rule.get("ruleId"), "evidenceId": evidence.get("evidenceId"), "eventId": evidence.get("eventId"), "lookFor": {"features": rule.get("features", []), "acceptanceQuote": rule.get("quote")}, **screen}
        if meta_adapter.needs_review(screen, rule):
            ctx.record(self.name, "escalated-to-review", evidence.get("eventId", ""))
            review = await asyncio.to_thread(meta_adapter.review_visual, resolve_evidence_file(evidence), rule, screen, "photo")
            obs["review"] = review
        ctx.record(self.name, "completed" if screen.get("status") != "unavailable" else "unavailable", evidence.get("eventId", ""))
        return obs



def resolve_evidence_file(evidence: dict) -> str:
    """Local path for an evidence file: direct path when present, else
    download evidence['url'] (API file endpoint) once into a cache keyed by
    URL. The agent services do not share the API's data volume, so URLs
    are the contract; evidence bytes are immutable, so the cache is safe."""
    path = evidence.get("path") or ""
    if path and os.path.exists(path):
        return path
    url = evidence.get("url") or ""
    if not url:
        return path
    import hashlib
    import tempfile
    suffix = os.path.splitext(evidence.get("filename") or url.split("/")[-1] or ".ply")[1] or ".ply"
    cache = os.path.join(tempfile.gettempdir(), "argus-evidence")
    os.makedirs(cache, exist_ok=True)
    target = os.path.join(cache, hashlib.sha256(url.encode()).hexdigest() + suffix)
    if not os.path.exists(target):
        tmp = target + ".part"
        with open(tmp, "wb") as fh, urllib.request.urlopen(url, timeout=120) as resp:
            fh.write(resp.read())
        os.replace(tmp, target)
    return target


class PointCloudAgent(SubAgent):
    name = "pointcloud-agent"
    media_types = {"pointcloud"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        reg = await asyncio.to_thread(geometry.register, resolve_evidence_file(evidence))
        obs = {"kind": "geometry", "ruleId": rule.get("ruleId"), "lookFor": {"features": rule.get("features", []), "thresholdMm": rule.get("thresholdMm")}, "registration": reg,
               "measurement": {"valueMm": reg.get("meanDeviationMm")} if reg.get("meanDeviationMm") is not None else None,
               "tool": "open3d"}
        ctx.record(self.name, "completed", f"rmse={reg.get('rmseMm')} coverage={reg.get('surfaceCoverageFraction')}")
        return obs

    async def compare_merged(self, ctx, evidences, rules: list[dict] | None = None, model_id: str | None = None):
        """Merge every point-cloud chunk of the session into one scan and
        register it against the CAD reference of the session's model
        (coverage needs the whole). Each pinned scan rule is then decided
        by the deterministic gate from that one geometry observation."""
        ctx.record(self.name, "started", f"merged comparison of {len(evidences)} chunks")
        paths = [resolve_evidence_file(ev) for ev in evidences]
        cad_path = None
        if model_id:
            import cad_reference
            cad_path = (await asyncio.to_thread(cad_reference.reference_for_model, model_id))["referencePly"]
        reg = await asyncio.to_thread(geometry.register_merged, paths, cad_path)
        obs = {"kind": "geometry", "registration": reg, "units": "mm",
               "measurement": {"valueMm": reg.get("meanDeviationMm")} if reg.get("meanDeviationMm") is not None else None,
               "tool": "open3d", "mergedChunks": reg.get("mergedChunks", 0)}
        obs["ruleResults"] = [{"ruleId": r.get("ruleId"), "ruleStatus": coordinator.evaluate_rule(r, [obs]),
                               "threshold": r.get("threshold")} for r in (rules or [])
                              if "pointcloud" in (r.get("modalities") or []) and r.get("threshold")]
        ctx.record(self.name, "completed", f"rms={reg.get('rmsDeviationMm')} coverage={reg.get('surfaceCoverageFraction')} chunks={reg.get('mergedChunks')}")
        return obs


class ReportAgent(SubAgent):
    """Aggregates finished observations into the deviation-report payload.
    Not media-driven: invoked by the orchestrator at closure/report time."""
    name = "report-agent"
    media_types = set()

    async def run(self, ctx, evidence, rule):  # pragma: no cover - media path unused
        raise NotImplementedError("ReportAgent is invoked via build_report()")

    def build_pdf(self, ctx: InspectionContext, dossier: dict) -> bytes:
        """The frozen dossier as a printable PDF (layout only; no judgement)."""
        import dossier_pdf
        ctx.record(self.name, "started", "dossier pdf")
        pdf = dossier_pdf.build_pdf(dossier)
        ctx.record(self.name, "completed", f"dossier pdf {len(pdf)} bytes")
        return pdf

    def build_report(self, ctx: InspectionContext, findings: list[dict]) -> dict:
        ctx.record(self.name, "started", f"{len(findings)} findings")
        report = {
            "sessionId": ctx.session_id,
            "findings": findings,
            "outcome": coordinator.aggregate_outcome([f["ruleStatus"] for f in findings]),
            "agentLog": list(ctx.log),
        }
        ctx.record(self.name, "completed", report["outcome"])
        return report


class JobStore:
    """Persisted job ledger (JSON) so a crashed/restarted orchestrator can
    re-dispatch unfinished work with the *original* evidence + rule payload,
    under the *same* sessionId. A job is keyed (sessionId, eventId): a retry
    or a simulator resend with the same eventId never creates duplicate work,
    mirroring the (sessionId, eventId) idempotency at the Argus API."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.jobs: dict[str, dict] = {}
        if path and os.path.exists(path):
            try:
                self.jobs = json.loads(open(path).read())
            except Exception:
                self.jobs = {}

    def _save(self) -> None:
        if self.path:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            open(self.path, "w").write(json.dumps(self.jobs, indent=1))

    @staticmethod
    def _key(session_id: str, evidence: dict, rule: dict | None = None) -> str:
        return f"{session_id}:{evidence.get('eventId', '')}:{(rule or {}).get('ruleId', '')}"

    def enqueue(self, ctx: InspectionContext, evidence: dict, rule: dict) -> str:
        key = self._key(ctx.session_id, evidence, rule)
        if key not in self.jobs:
            self.jobs[key] = {"sessionId": ctx.session_id, "evidence": evidence, "rule": rule, "state": "PENDING", "attempts": 0}
            self._save()
        return key

    def mark(self, key: str, state: str) -> None:
        if key in self.jobs:
            self.jobs[key]["state"] = state
            self.jobs[key]["attempts"] = self.jobs[key].get("attempts", 0) + 1
            self._save()

    def pending(self) -> list[dict]:
        return [j for j in self.jobs.values() if j["state"] in ("PENDING", "FAILED")]


AGENT_ENDPOINTS = {
    "video": os.environ.get("VIDEO_AGENT_URL", "http://127.0.0.1:8101"),
    "photo": os.environ.get("IMAGE_AGENT_URL", "http://127.0.0.1:8102"),
    "pointcloud": os.environ.get("POINTCLOUD_AGENT_URL", "http://127.0.0.1:8103"),
}


class RemoteSubAgent(SubAgent):
    """Proxy to a sub-agent running as its own HTTP service (agent_service.py).
    The orchestrator talks to it over HTTP, so it crashes, restarts, and
    scales independently of the orchestrator and its sibling agents."""

    def __init__(self, local: SubAgent) -> None:
        self._local = local
        self.name = local.name
        self.media_types = set(local.media_types)

    async def run(self, ctx: InspectionContext, evidence: dict, rule: dict) -> dict:
        media = evidence.get("mediaType", "")
        url = AGENT_ENDPOINTS[media] + "/run"
        payload = json.dumps({"evidence": evidence, "rule": rule, "sessionId": ctx.session_id}).encode()

        def _post() -> dict:
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=float(os.environ.get("AGENT_HTTP_TIMEOUT_S", "300"))) as resp:
                return json.loads(resp.read())

        result = await asyncio.to_thread(_post)
        if result.get("kind") == "rejected":
            raise RuntimeError(result.get("error", "rejected by remote agent"))
        for entry in result.get("log", []):
            ctx.log.append(entry)
        ctx.record(self.name, "remote-completed", evidence.get("eventId", ""))
        return result["observation"]


class Orchestrator:
    """Planner: routes each evidence event to the sub-agent that owns its
    media type, dispatching independent events in parallel. All outcomes are
    logged under the shared InspectionContext for the session.

    Retry/recovery semantics (same inspection context throughout):
    - A retried stream item (same sessionId + eventId, e.g. a Simulator resend)
      is enqueued once; the owning sub-agent picks it up again and its output
      is logged under the same session.
    - A sub-agent that raises is retried with exponential backoff up to
      AGENT_MAX_RETRIES; siblings are never blocked.
    - Jobs are persisted via JobStore before dispatch. If the process dies,
      a new Orchestrator over the same store re-dispatches PENDING/FAILED jobs
      with their original payloads via recover_pending().
    """

    def __init__(self, store_path: str = "", max_retries: int | None = None, transport: str | None = None) -> None:
        # transport="http": each sub-agent is its own service (agent_service.py).
        # transport="local": in-process classes (tests / fallback). Default from env.
        self.transport = transport or os.environ.get("AGENT_TRANSPORT", "http")
        locals_ = [VideoAgent(), ImageAgent(), PointCloudAgent()]
        self.agents: list[SubAgent] = [RemoteSubAgent(a) for a in locals_] if self.transport == "http" else locals_
        self.report_agent = ReportAgent()
        self.store = JobStore(store_path or os.environ.get("AGENT_JOBS_FILE", ""))
        self.max_retries = max_retries if max_retries is not None else int(os.environ.get("AGENT_MAX_RETRIES", "3"))
        self.retry_base_s = float(os.environ.get("AGENT_RETRY_BASE_S", "0.5"))

    def route(self, evidence: dict) -> SubAgent | None:
        for agent in self.agents:
            if agent.accepts(evidence):
                return agent
        return None

    async def dispatch_one(self, ctx: InspectionContext, evidence: dict, rule: dict) -> dict:
        agent = self.route(evidence)
        if agent is None:
            ctx.record("orchestrator", "skipped", f"no agent for {evidence.get('mediaType')}")
            return {"kind": "skipped", "mediaType": evidence.get("mediaType")}
        key = self.store.enqueue(ctx, evidence, rule)
        ctx.record("orchestrator", "routed", f"{evidence.get('eventId')} -> {agent.name}")
        last_error = ""
        for attempt in range(1, self.max_retries + 1):
            try:
                obs = await agent.run(ctx, evidence, rule)
                self.store.mark(key, "DONE")
                obs["ruleStatus"] = coordinator.evaluate_rule(rule, [obs] if obs.get("kind") in ("geometry", "possible_surface_line", "component_present", "component_absent") else [])
                return obs
            except Exception as exc:  # failure is isolated; retry, never block siblings
                last_error = str(exc)
                self.store.mark(key, "FAILED")
                ctx.record(agent.name, "failed", f"attempt {attempt}/{self.max_retries}: {exc}")
                if attempt < self.max_retries:
                    ctx.record("orchestrator", "retrying", f"{evidence.get('eventId')} attempt {attempt + 1} under {ctx.session_id}")
                    await asyncio.sleep(self.retry_base_s * (2 ** (attempt - 1)))
        return {"kind": "failed", "mediaType": evidence.get("mediaType"), "error": last_error}

    async def dispatch(self, ctx: InspectionContext, items: list[tuple[dict, dict]]) -> list[dict]:
        """Independent events (video/image/pointcloud, any mix) run in parallel."""
        return await asyncio.gather(*(self.dispatch_one(ctx, ev, rule) for ev, rule in items))

    async def dispatch_evidence(self, ctx: InspectionContext, evidences: list[dict], worklist: dict,
                                family: str | None = None, type: str | None = None,
                                order_context: str | None = None, skip_rule_ids: list[str] | None = None) -> list[dict]:
        """SAM-routed dispatch: for each photo/video, SAM 3.1 detects which
        components are present, then the deterministic visual-routing
        mapping for the session's equipment family/type
        (visual_routing.select_rules) picks which applicable rules may be
        applied to that evidence. Rules routed to components that are not
        visible are not applied; rules needing evidence outside the image
        are skipped unless critical, in which case they are returned as
        INSUFFICIENT_EVIDENCE (evidence needed) without being screened.
        With an order document, `document` needs are met and the order
        text travels with the rule. Rules already decided by earlier
        evidence (skip_rule_ids, video only) are not re-screened.
        Each photo/video also yields one `detections` observation carrying
        SAM's boxes and masks. No task -> logged as unassociated, never
        silently analysed against an invented rule."""
        import worklist as wl
        import visual_routing as vr
        jobs: list[tuple[dict, dict]] = []
        extra: list[dict] = []
        skip = set(skip_rule_ids or [])
        for ev in evidences:
            tasks = wl.associate(ev, worklist)
            if not tasks:
                ctx.record("orchestrator", "unassociated", f"{ev.get('eventId')}: no worklist task for {ev.get('mediaType')}")
                continue
            mapping = None
            if ev.get("mediaType") in ("photo", "video"):
                source = "video" if ev.get("mediaType") == "video" else "photo"
                mapping = vr.get_mapping(ev.get("family") or family or "", ev.get("type") or type or "")
                detected = ev.get("detectedComponents")
                if detected is None:
                    components = vr.relevant_components(mapping, tasks)
                    found = await asyncio.to_thread(
                        meta_adapter.detect_components, resolve_evidence_file(ev), source, components)
                    detected = [c["id"] for c in found if c.get("boxes") and not c.get("error")]
                    extra.append({"kind": "detections", "source": source, "evidenceId": ev.get("evidenceId"),
                                  "eventId": ev.get("eventId"), "model": meta_adapter.SAM_MODEL, "components": found})
                ctx.record("orchestrator", "sam-detected",
                           f"{ev.get('eventId')}: {', '.join(detected) if detected else 'no components detected'}")
                routed = vr.select_rules(tasks, list(detected), source, mapping, order_document=bool(order_context))
                for t in routed["skipped"]:
                    ctx.record("orchestrator", "rule-skipped", f"{ev.get('eventId')} rule {t.get('ruleId')}: {t.get('reason')}")
                for t in routed["evidenceNeeded"]:
                    ctx.record("orchestrator", "evidence-needed", f"{ev.get('eventId')} rule {t.get('ruleId')}: {t.get('reason')}")
                    extra.append({
                        "kind": "evidence_needed", "source": source, "ruleId": t.get("ruleId"),
                        "ruleStatus": "INSUFFICIENT_EVIDENCE",
                        "evidenceId": ev.get("evidenceId"), "eventId": ev.get("eventId"),
                        "needs": t.get("needs", []), "notes": t.get("reason", ""),
                    })
                tasks = routed["selected"]
                if source == "video" and skip:
                    for t in [t for t in tasks if t.get("ruleId") in skip]:
                        ctx.record("orchestrator", "rule-already-decided", f"{ev.get('eventId')} rule {t.get('ruleId')}")
                    tasks = [t for t in tasks if t.get("ruleId") not in skip]
            for task in tasks:
                rule = wl.task_envelope(ctx.session_id, ev, task)["rule"]
                compares_order = task.get("origin") == "order" or (mapping and "document" in vr.classify_rule(task, mapping))
                if order_context and compares_order:
                    rule = {**rule, "orderContext": order_context}
                jobs.append((ev, rule))
        return await self.dispatch(ctx, jobs) + extra

    async def recover_pending(self, contexts: dict[str, InspectionContext]) -> list[dict]:
        """After a restart, spin the owning sub-agents back up for every
        persisted PENDING/FAILED job, with the original data, under the
        original sessionId (context is reused or recreated for that session)."""
        results = []
        for job in self.store.pending():
            ctx = contexts.setdefault(job["sessionId"], InspectionContext(session_id=job["sessionId"]))
            ctx.record("orchestrator", "recovered", f"re-dispatching {job['evidence'].get('eventId')} after restart")
            results.append(await self.dispatch_one(ctx, job["evidence"], job["rule"]))
        return results
