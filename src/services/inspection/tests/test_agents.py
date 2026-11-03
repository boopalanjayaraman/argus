import sys, pathlib, asyncio, time
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from agents import Orchestrator, InspectionContext, VideoAgent, ImageAgent, PointCloudAgent

RULE = {"ruleId": "WO-R02", "modalities": ["photo", "pointcloud", "video"], "features": ["inlet_flange_face"], "applicability": "APPROVED"}

def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)

def test_boundaries():
    orch = Orchestrator(transport="local")
    assert orch.route({"mediaType": "video"}).name == "video-agent"
    assert orch.route({"mediaType": "photo"}).name == "image-agent"
    assert orch.route({"mediaType": "pointcloud"}).name == "pointcloud-agent"
    assert orch.route({"mediaType": "audio"}) is None
    assert not VideoAgent().accepts({"mediaType": "photo"})
    assert ImageAgent().accepts({"mediaType": "photo"})
    assert PointCloudAgent().accepts({"mediaType": "pointcloud"})

def test_parallel_dispatch_and_shared_session_log():
    async def main():
        orch = Orchestrator(transport="local")
        ctx = InspectionContext(session_id="insp-test")
        # pointcloud path missing -> agent returns insufficient observation, siblings unaffected
        items = [
            ({"mediaType": "photo", "eventId": "img-1", "path": ""}, RULE),
            ({"mediaType": "video", "eventId": "vid-1", "path": ""}, RULE),
            ({"mediaType": "pointcloud", "eventId": "ply-1", "path": "/nonexistent.ply"}, RULE),
        ]
        out = await orch.dispatch(ctx, items)
        assert len(out) == 3
        assert all(e["sessionId"] == "insp-test" for e in ctx.log)
        agents_logged = {e["agent"] for e in ctx.log}
        assert {"image-agent", "video-agent", "pointcloud-agent", "orchestrator"} <= agents_logged
    run(main())

def test_retry_same_session_and_crash_recovery(tmp_path):
    import agents as agents_mod
    async def main():
        store = str(tmp_path / "jobs.json")
        orch = Orchestrator(store_path=store, max_retries=3, transport="local")
        orch.retry_base_s = 0.01
        ctx = InspectionContext(session_id="insp-retry")
        # Flaky agent: crashes twice, then succeeds — orchestrator retries it
        # under the same session context.
        calls = {"n": 0}
        orig = agents_mod.ImageAgent.run
        async def flaky(self, c, ev, rule):
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("boom")
            return {"kind": "visual", "status": "ok"}
        agents_mod.ImageAgent.run = flaky
        try:
            out = await orch.dispatch_one(ctx, {"mediaType": "photo", "eventId": "img-9", "path": ""}, RULE)
        finally:
            agents_mod.ImageAgent.run = orig
        assert out["kind"] == "visual" and calls["n"] == 3
        assert any(e["event"] == "retrying" for e in ctx.log)
        assert all(e["sessionId"] == "insp-retry" for e in ctx.log)
        # Same (sessionId, eventId) resent: one job only in the store.
        orch2 = Orchestrator(store_path=store, max_retries=1, transport="local")
        assert len([j for j in orch2.store.jobs.values() if j["evidence"].get("eventId") == "img-9"]) == 1
        # Crash recovery: leave a FAILED job, new orchestrator re-dispatches it
        # with the original payload under the original sessionId.
        orch2.store.jobs["insp-retry:ply-9"] = {"sessionId": "insp-retry", "evidence": {"mediaType": "pointcloud", "eventId": "ply-9", "path": "/nonexistent.ply"}, "rule": RULE, "state": "FAILED", "attempts": 1}
        orch2.store._save()
        orch3 = Orchestrator(store_path=store, max_retries=1, transport="local")
        contexts: dict = {}
        res = await orch3.recover_pending(contexts)
        assert res and res[0]["kind"] == "geometry"
        assert contexts["insp-retry"].log[0]["sessionId"] == "insp-retry"
        assert any(e["event"] == "recovered" for e in contexts["insp-retry"].log)
    run(main())

def test_agent_failure_isolated():
    async def main():
        orch = Orchestrator(transport="local")
        ctx = InspectionContext(session_id="insp-x")
        out = await orch.dispatch_one(ctx, {"mediaType": "pointcloud", "eventId": "p1", "path": "/nonexistent/x.ply"}, RULE)
        assert out["kind"] == "geometry"  # register() returns insufficient, does not raise
    run(main())


def test_resolve_evidence_file_downloads_from_url(tmp_path):
    import agents
    src = tmp_path / "chunk.ply"
    src.write_bytes(b"ply-bytes")
    out = agents.resolve_evidence_file({"url": src.as_uri(), "filename": "chunk.ply"})
    assert open(out, "rb").read() == b"ply-bytes"


def test_resolve_evidence_file_prefers_existing_path(tmp_path):
    import agents
    src = tmp_path / "chunk.ply"
    src.write_bytes(b"x")
    assert agents.resolve_evidence_file({"path": str(src), "url": "http://invalid"}) == str(src)
