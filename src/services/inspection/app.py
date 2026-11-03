"""Inspection service HTTP surface. Run: .venv/bin/uvicorn app:app --port 8100

Orchestrator + independent sub-agents (agents.py): each evidence event is
routed to the one sub-agent that owns its media type; independent events run
in parallel; all outcomes log under the shared session context. The Argus
API sends the session's pinned rule snapshot with every request, so the
rules analysed are always the ones pinned at session creation.
"""
import json
import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import coordinator, geometry, meta_adapter
import documents
import worklist as wl
from agents import Orchestrator, InspectionContext, resolve_evidence_file

app = FastAPI(title="argus-inspection")
orchestrator = Orchestrator(store_path=os.environ.get("AGENT_JOBS_FILE", "data/agent_jobs.json"))
contexts: dict[str, InspectionContext] = {}


@app.on_event("startup")
async def _recover():
    # Spin sub-agents back up for jobs a previous crash left unfinished,
    # with their original payloads under their original sessionIds.
    if orchestrator.store.pending():
        await orchestrator.recover_pending(contexts)


class AnalyzeRequest(BaseModel):
    evidence: dict
    rule: dict
    sessionId: str = "insp-unknown"


class BatchRequest(BaseModel):
    sessionId: str
    items: list[AnalyzeRequest]


class EvidenceBatchRequest(BaseModel):
    sessionId: str
    model_id: str = "CVS6000_VALVE"
    family: str | None = None
    type: str | None = None
    rules: list[dict] | None = None  # pinned session snapshot
    orderContext: str | None = None
    skipRuleIds: list[str] | None = None
    evidences: list[dict]


@app.get("/health")
def health():
    return {"ok": True, "geometry": bool(geometry.CAD_REFERENCE_PLY), "metaConfigured": meta_adapter._configured(),
            "samModel": meta_adapter.SAM_MODEL, "agents": [a.name for a in orchestrator.agents] + ["report-agent"]}


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    ctx = contexts.setdefault(req.sessionId, InspectionContext(session_id=req.sessionId))
    obs = await orchestrator.dispatch_one(ctx, req.evidence, req.rule)
    return {"observation": obs, "agentLog": ctx.log}


@app.post("/analyze-batch")
async def analyze_batch(req: BatchRequest):
    ctx = contexts.setdefault(req.sessionId, InspectionContext(session_id=req.sessionId))
    observations = await orchestrator.dispatch(ctx, [(i.evidence, i.rule) for i in req.items])
    return {"observations": observations, "agentLog": ctx.log}


@app.get("/worklist/{model_id}")
def get_worklist(model_id: str):
    return wl.build_worklist(model_id)


@app.post("/analyze-evidence")
async def analyze_evidence(req: EvidenceBatchRequest):
    """Rule-guided entry point: build the worklist from the pinned rules,
    let SAM route each photo/video to the rules its visible components
    allow, and dispatch task envelopes to the owning sub-agents."""
    ctx = contexts.setdefault(req.sessionId, InspectionContext(session_id=req.sessionId))
    worklist = wl.build_worklist(req.model_id, rules=req.rules)
    try:
        observations = await orchestrator.dispatch_evidence(
            ctx, req.evidences, worklist, family=req.family, type=req.type,
            order_context=req.orderContext, skip_rule_ids=req.skipRuleIds)
    except KeyError as exc:  # no routing mapping for this equipment
        raise HTTPException(status_code=422, detail=str(exc))
    return {"worklist": worklist["counts"], "observations": observations, "agentLog": ctx.log}


class CompareMergedRequest(BaseModel):
    sessionId: str
    model_id: str = "CVS6000_VALVE"
    rules: list[dict] | None = None
    evidences: list[dict]


@app.post("/compare-merged")
async def compare_merged(req: CompareMergedRequest):
    """Merged-scan CAD comparison: all chunks of the session as one cloud,
    registered against the CAD reference by the pointcloud-agent; pinned
    scan rules are decided from it by the deterministic gate."""
    ctx = contexts.setdefault(req.sessionId, InspectionContext(session_id=req.sessionId))
    if os.environ.get("AGENT_TRANSPORT") == "http":
        import urllib.request as ur
        payload = json.dumps({"evidences": req.evidences, "sessionId": req.sessionId,
                              "rules": req.rules or [], "model_id": req.model_id}).encode()
        request = ur.Request(os.environ.get("POINTCLOUD_AGENT_URL", "http://127.0.0.1:8103") + "/compare-merged",
                             data=payload, headers={"Content-Type": "application/json"})
        with ur.urlopen(request, timeout=600) as resp:
            result = json.loads(resp.read())
        for entry in result.get("log", []):
            ctx.log.append(entry)
        return {"observation": result["observation"], "agentLog": ctx.log}
    agent = next(a for a in orchestrator.agents if a.name == "pointcloud-agent")
    local = getattr(agent, "_local", agent)
    obs = await local.compare_merged(ctx, req.evidences, rules=req.rules, model_id=req.model_id)
    return {"observation": obs, "agentLog": ctx.log}


class DocumentRequest(BaseModel):
    url: str | None = None
    path: str | None = None
    filename: str


@app.post("/documents/extract")
def extract_document(req: DocumentRequest):
    """Text, order number and explicitly numbered order rules of an uploaded
    customer specification / work order (PDF, DOCX, XLSX)."""
    local = resolve_evidence_file({"url": req.url, "path": req.path, "filename": req.filename})
    try:
        return documents.describe(local, req.filename)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not read document: {exc}")


@app.get("/sessions/{session_id}/log")
def session_log(session_id: str):
    ctx = contexts.get(session_id)
    return {"sessionId": session_id, "log": ctx.log if ctx else []}
