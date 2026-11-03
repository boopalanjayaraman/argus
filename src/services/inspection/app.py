"""Inspection service HTTP surface. Run: .venv/bin/uvicorn app:app --port 8100

Orchestrator + independent sub-agents (agents.py): each evidence event is
routed to the one sub-agent that owns its media type; independent events run
in parallel; all outcomes log under the shared session context.
"""
import os
from fastapi import FastAPI
from pydantic import BaseModel
import coordinator, geometry, meta_adapter
import worklist as wl
from agents import Orchestrator, InspectionContext

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
    evidences: list[dict]


@app.get("/health")
def health():
    return {"ok": True, "geometry": bool(geometry.CAD_REFERENCE_PLY), "metaConfigured": meta_adapter._configured(), "agents": [a.name for a in orchestrator.agents] + ["report-agent"]}


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
    import worklist as wl
    return wl.build_worklist(model_id)


@app.post("/analyze-evidence")
async def analyze_evidence(req: EvidenceBatchRequest):
    """Rule-guided entry point: build the session worklist for the CAD model,
    associate each evidence item to its task(s), and dispatch task envelopes
    to the owning sub-agents in parallel."""
    import worklist as wl
    ctx = contexts.setdefault(req.sessionId, InspectionContext(session_id=req.sessionId))
    worklist = wl.build_worklist(req.model_id)
    observations = await orchestrator.dispatch_evidence(ctx, req.evidences, worklist)
    return {"worklist": worklist["counts"], "observations": observations, "agentLog": ctx.log}


@app.get("/sessions/{session_id}/log")
def session_log(session_id: str):
    ctx = contexts.get(session_id)
    return {"sessionId": session_id, "log": ctx.log if ctx else []}
