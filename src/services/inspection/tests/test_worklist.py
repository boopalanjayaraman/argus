import sys, pathlib, asyncio
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import worklist as wl
from agents import Orchestrator, InspectionContext

def test_worklist_excludes_reference_only():
    w = wl.build_worklist("CVS6000_VALVE")
    assert w["counts"]["tasks"] >= 4
    assert all(t["ruleId"] != "REF-R05" for t in w["tasks"])
    assert any(e["ruleId"] == "REF-R05" for e in w["excluded"])
    assert all(t["quote"] for t in w["tasks"])

def test_association_by_modality_and_feature():
    w = wl.build_worklist("CVS6000_VALVE")
    photos = wl.associate({"mediaType": "photo", "eventId": "img-1"}, w)
    assert photos and all("photo" in t["modalities"] for t in photos)
    scans = wl.associate({"mediaType": "pointcloud", "eventId": "ply-1"}, w)
    assert scans and all("pointcloud" in t["modalities"] for t in scans)
    flange = wl.associate({"mediaType": "photo", "eventId": "img-2", "featureId": "inlet_flange_face"}, w)
    assert flange and all("inlet_flange_face" in t["features"] for t in flange)
    assert wl.associate({"mediaType": "audio", "eventId": "a-1"}, w) == []

def test_envelope_carries_pinned_rule_not_verdict():
    w = wl.build_worklist("CVS6000_VALVE")
    task = wl.associate({"mediaType": "photo", "eventId": "img-1"}, w)[0]
    env = wl.task_envelope("insp-1", {"mediaType": "photo", "eventId": "img-1"}, task)
    assert env["lookFor"]["acceptanceQuote"] == task["quote"]
    assert "ruleStatus" not in env and "PASS" not in str(env["lookFor"])

def test_dispatch_evidence_is_rule_guided():
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-wl")
        w = wl.build_worklist("CVS6000_VALVE")
        out = await orch.dispatch_evidence(ctx, [
            {"mediaType": "photo", "eventId": "img-1", "path": ""},
            {"mediaType": "pointcloud", "eventId": "ply-1", "path": "/nonexistent.ply"},
            {"mediaType": "audio", "eventId": "a-1"},
        ], w)
        assert out and all(o.get("ruleId") for o in out)
        assert any(e["event"] == "unassociated" for e in ctx.log)
    asyncio.run(main())
