import sys, pathlib, asyncio
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import worklist as wl
from agents import Orchestrator, InspectionContext

def test_worklist_excludes_reference_only():
    # Session worklist comes from the full Inspection Rules library:
    # photo/video-evidence rules are tasks; measurement, functional-test
    # and work-order rules are excluded until those records exist.
    w = wl.build_worklist("CVS6000_VALVE")
    assert w["counts"]["library"] == 158
    assert w["counts"]["tasks"] == 69
    assert w["counts"]["excluded"] == 89
    assert all(t["quote"] for t in w["tasks"])
    assert all("photo" in t["modalities"] or "video" in t["modalities"] for t in w["tasks"])

def test_association_by_modality_and_feature():
    w = wl.build_worklist("CVS6000_VALVE")
    photos = wl.associate({"mediaType": "photo", "eventId": "img-1"}, w)
    assert photos and all("photo" in t["modalities"] for t in photos)
    # The library has no scan-evidence rules: point-cloud geometry is
    # handled by the merged CAD comparison, not by worklist tasks.
    scans = wl.associate({"mediaType": "pointcloud", "eventId": "ply-1"}, w)
    assert scans == []
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
            {"mediaType": "photo", "eventId": "img-1", "path": "", "detectedComponents": ["flange_face"]},
            {"mediaType": "pointcloud", "eventId": "ply-1", "path": "/nonexistent.ply"},
            {"mediaType": "audio", "eventId": "a-1"},
        ], w)
        assert out and all(o.get("ruleId") for o in out)
        assert any(e["event"] == "unassociated" for e in ctx.log)
    asyncio.run(main())


def test_dispatch_routes_only_detected_component_rules():
    # A flange-only photo is screened against flange rules only: none of
    # the other applicable rules are applied to this image.
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-route")
        w = wl.build_worklist("CVS6000_VALVE")
        out = await orch.dispatch_evidence(ctx, [
            {"mediaType": "photo", "eventId": "img-f", "path": "", "detectedComponents": ["flange_face"]},
        ], w)
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert screened and screened <= {"4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"}
        assert any(e["event"] == "sam-detected" and "flange_face" in e["detail"] for e in ctx.log)
    asyncio.run(main())


def test_dispatch_critical_external_rule_is_evidence_needed_not_screened():
    # Critical rule needing a test record: reported as evidence needed,
    # never screened. Non-critical document rule: skipped silently.
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-crit")
        w = {"tasks": [
            {"ruleId": "9.5", "title": "Seat test", "quote": "No visible leakage (test performed)", "modalities": ["photo", "video"], "features": []},
            {"ruleId": "2.2", "title": "Body material", "quote": "matches MTC and PO", "modalities": ["photo", "video"], "features": []},
        ]}
        out = await orch.dispatch_evidence(ctx, [
            {"mediaType": "photo", "eventId": "img-c", "path": "", "detectedComponents": ["full_valve", "body_markings"]},
        ], w)
        needed = {o["ruleId"] for o in out if o.get("kind") == "evidence_needed"}
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert needed == {"9.5"}
        assert all(o["ruleStatus"] == "INSUFFICIENT_EVIDENCE" for o in out if o.get("kind") == "evidence_needed")
        assert "2.2" not in screened and "9.5" not in screened
    asyncio.run(main())


def test_dispatch_video_uses_same_routing():
    # Video segments route like photos; dynamic operation rules are
    # decidable from video, seat-test evidence is not.
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-vid")
        w = wl.build_worklist("CVS6000_VALVE")
        out = await orch.dispatch_evidence(ctx, [
            {"mediaType": "video", "eventId": "vid-1", "path": "", "detectedComponents": ["full_valve"]},
        ], w)
        needed = {o["ruleId"] for o in out if o.get("kind") == "evidence_needed"}
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert "9.5" in needed
        assert screened and screened <= {"10.1", "10.2", "10.4", "10.5", "10.6", "10.7", "9.1", "9.2", "9.4", "8.4"}
    asyncio.run(main())


def test_visual_routing_mapping_is_generic_family_type():
    import visual_routing as vr
    assert vr.CONFIG_PATH.name == "visual-routing.json"
    mapping = vr.get_mapping("Valve", "ball")
    assert mapping["family"] == "Valve" and mapping["type"] == "ball"
    assert mapping["components"]
    try:
        vr.get_mapping("Valve", "gate")
        raise AssertionError("unknown type must not resolve")
    except KeyError:
        pass


def test_visual_routing_selects_only_detected_components():
    import visual_routing as vr
    tasks = [
        {"ruleId": "4.3", "title": "Gasket face damage", "quote": "No radial scratches"},
        {"ruleId": "2.7", "title": "Identification plate fixed securely", "quote": "Not loose"},
        {"ruleId": "3.1", "title": "Cracks", "quote": "No crack-type defects allowed"},
    ]
    routed = vr.select_rules(tasks, ["flange_face"], "photo")
    assert [t["ruleId"] for t in routed["selected"]] == ["4.3"]
    assert routed["evidenceNeeded"] == [] and routed["skipped"] == []


def test_visual_routing_skips_document_rules_unless_critical():
    import visual_routing as vr
    tasks = [
        {"ruleId": "2.2", "title": "Body material designation", "quote": "matches MTC and PO"},
        {"ruleId": "NP-003", "title": "Serial format", "quote": "must match work order. Else FAIL."},
        {"ruleId": "NP-001", "title": "Nameplate present", "quote": "nameplate must be present and stamped. Absent/unstamped = FAIL."},
    ]
    routed = vr.select_rules(tasks, ["nameplate", "body_markings"], "photo")
    assert [t["ruleId"] for t in routed["skipped"]] == ["2.2"]
    assert [t["ruleId"] for t in routed["evidenceNeeded"]] == ["NP-003"]
    assert [t["ruleId"] for t in routed["selected"]] == ["NP-001"]
