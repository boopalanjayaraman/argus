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
    name = "video-agent"
    media_types = {"video"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        result = await asyncio.to_thread(meta_adapter.visual_observation, evidence.get("path", ""), rule)
        obs = {"kind": "visual", "source": "video", "ruleId": rule.get("ruleId"), "lookFor": {"features": rule.get("features", []), "acceptanceQuote": rule.get("quote")}, **result}
        ctx.record(self.name, "completed" if result.get("status") != "unavailable" else "unavailable", evidence.get("eventId", ""))
        return obs


class ImageAgent(SubAgent):
    name = "image-agent"
    media_types = {"photo"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        result = await asyncio.to_thread(meta_adapter.visual_observation, evidence.get("path", ""), rule)
        obs = {"kind": "visual", "source": "photo", "ruleId": rule.get("ruleId"), "lookFor": {"features": rule.get("features", []), "acceptanceQuote": rule.get("quote")}, **result}
        ctx.record(self.name, "completed" if result.get("status") != "unavailable" else "unavailable", evidence.get("eventId", ""))
        return obs


class PointCloudAgent(SubAgent):
    name = "pointcloud-agent"
    media_types = {"pointcloud"}

    async def run(self, ctx, evidence, rule):
        ctx.record(self.name, "started", evidence.get("eventId", ""))
        reg = await asyncio.to_thread(geometry.register, evidence.get("path", ""))
        obs = {"kind": "geometry", "ruleId": rule.get("ruleId"), "lookFor": {"features": rule.get("features", []), "thresholdMm": rule.get("thresholdMm")}, "registration": reg,
               "measurement": {"valueMm": reg.get("meanDeviationMm")} if reg.get("meanDeviationMm") is not None else None,
               "tool": "open3d"}
        ctx.record(self.name, "completed", f"rmse={reg.get('rmseMm')} coverage={reg.get('surfaceCoverageFraction')}")
        return obs


class ReportAgent(SubAgent):
    """Aggregates finished observations into the deviation-report payload.
    Not media-driven: invoked by the orchestrator at closure/report time."""
    name = "report-agent"
    media_types = set()

    async def run(self, ctx, evidence, rule):  # pragma: no cover - media path unused
        raise NotImplementedError("ReportAgent is invoked via build_report()")

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
    def _key(session_id: str, evidence: dict) -> str:
        return f"{session_id}:{evidence.get('eventId', '')}"

    def enqueue(self, ctx: InspectionContext, evidence: dict, rule: dict) -> str:
        key = self._key(ctx.session_id, evidence)
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
            with urllib.request.urlopen(req, timeout=float(os.environ.get("AGENT_HTTP_TIMEOUT_S", "120"))) as resp:
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
                obs["ruleStatus"] = coordinator.evaluate_rule(rule, [obs] if obs.get("kind") in ("geometry", "possible_surface_line", "component_present") else [])
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

    async def dispatch_evidence(self, ctx: InspectionContext, evidences: list[dict], worklist: dict) -> list[dict]:
        """Rule-guided dispatch: associate each evidence item to its worklist
        task(s) first, then hand the owning sub-agent a task envelope (pinned
        quote, feature, threshold). No task -> logged as unassociated, never
        silently analysed against an invented rule."""
        import worklist as wl
        jobs: list[tuple[dict, dict]] = []
        for ev in evidences:
            tasks = wl.associate(ev, worklist)
            if not tasks:
                ctx.record("orchestrator", "unassociated", f"{ev.get('eventId')}: no worklist task for {ev.get('mediaType')}")
                continue
            for task in tasks:
                jobs.append((ev, wl.task_envelope(ctx.session_id, ev, task)["rule"]))
        return await self.dispatch(ctx, jobs)

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
