"""Run ONE sub-agent as its own independent HTTP service.

Usage: .venv/bin/python agent_service.py <video|image|pointcloud> <port>
Each service owns exactly one media type, has its own process lifecycle
(crash/restart independently), and answers POST /run + GET /health.
The orchestrator (app.py) dispatches to these over HTTP.
"""
import os
import sys
from fastapi import FastAPI
from pydantic import BaseModel
import agents as agents_mod

AGENTS = {
    "video": (agents_mod.VideoAgent, {"video"}),
    "image": (agents_mod.ImageAgent, {"photo"}),
    "pointcloud": (agents_mod.PointCloudAgent, {"pointcloud"}),
}


class RunRequest(BaseModel):
    evidence: dict
    rule: dict
    sessionId: str = "insp-unknown"


def build_app(kind: str) -> FastAPI:
    cls, media = AGENTS[kind]
    agent = cls()
    app = FastAPI(title=f"argus-{agent.name}")

    @app.get("/health")
    def health():
        return {"ok": True, "agent": agent.name, "mediaTypes": sorted(media)}

    class MergedRequest(BaseModel):
        evidences: list[dict]
        sessionId: str = "insp-unknown"
        rules: list[dict] | None = None
        model_id: str | None = None

    @app.post("/compare-merged")
    async def compare_merged(req: MergedRequest):
        if not hasattr(agent, "compare_merged"):
            return {"kind": "rejected", "agent": agent.name, "error": f"{agent.name} does not support merged comparison"}
        ctx = agents_mod.InspectionContext(session_id=req.sessionId)
        obs = await agent.compare_merged(ctx, req.evidences, rules=req.rules, model_id=req.model_id)
        return {"observation": obs, "agent": agent.name, "log": ctx.log}

    @app.post("/run")
    async def run(req: RunRequest):
        if req.evidence.get("mediaType") not in media:
            return {"kind": "rejected", "agent": agent.name,
                    "error": f"{agent.name} only accepts {sorted(media)}, got {req.evidence.get('mediaType')}"}
        ctx = agents_mod.InspectionContext(session_id=req.sessionId)
        obs = await agent.run(ctx, req.evidence, req.rule)
        return {"observation": obs, "agent": agent.name, "log": ctx.log}

    return app


if __name__ == "__main__":
    import uvicorn
    kind, port = sys.argv[1], int(sys.argv[2])
    uvicorn.run(build_app(kind), host=os.environ.get("AGENT_HOST", "127.0.0.1"), port=port)
