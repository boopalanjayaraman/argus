import sys, pathlib, asyncio
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import worklist as wl
import visual_routing as vr
from agents import Orchestrator, InspectionContext

SWING = {"family": "Valve", "type": "swing_check"}


def test_worklist_excludes_reference_only():
    # Without a pinned snapshot the worklist reads the indexed library:
    # photo/video and scan rules are tasks; measurement, functional-test
    # and work-order rules are excluded until those records exist.
    w = wl.build_worklist("CVS6000_VALVE")
    assert w["counts"]["library"] == 161
    assert w["counts"]["tasks"] == 72
    assert w["counts"]["excluded"] == 89
    assert all(t["quote"] for t in w["tasks"])
    assert all(set(t["modalities"]) & {"photo", "video", "pointcloud"} for t in w["tasks"])


def test_worklist_uses_pinned_snapshot_rules_when_given():
    pinned = [{"ruleId": "WO-R01", "quote": "Flanges match CAD", "modalities": ["photo"], "applicability": "APPROVED", "origin": "order"},
              {"ruleId": "WO-R07", "quote": "Test records", "modalities": [], "applicability": "REFERENCE_ONLY", "origin": "order"}]
    w = wl.build_worklist("CVS6000_VALVE", rules=pinned)
    assert [t["ruleId"] for t in w["tasks"]] == ["WO-R01"]
    assert w["tasks"][0]["origin"] == "order"


def test_association_by_modality_and_feature():
    w = wl.build_worklist("CVS6000_VALVE")
    photos = wl.associate({"mediaType": "photo", "eventId": "img-1"}, w)
    assert photos and all("photo" in t["modalities"] for t in photos)
    # Point clouds associate only with the scan rules (merged CAD comparison).
    scans = wl.associate({"mediaType": "pointcloud", "eventId": "ply-1"}, w)
    assert {t["ruleId"] for t in scans} == {"GEO-001", "GEO-002", "GEO-003"}
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
        ], w, **SWING)
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
        ], w, **SWING)
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert screened and screened <= {"4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"}
        assert any(e["event"] == "sam-detected" and "flange_face" in e["detail"] for e in ctx.log)
    asyncio.run(main())


def test_dispatch_refuses_equipment_without_mapping():
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-pump")
        w = wl.build_worklist("CVS6000_VALVE")
        try:
            await orch.dispatch_evidence(ctx, [{"mediaType": "photo", "eventId": "img-p", "path": "", "detectedComponents": []}],
                                         w, family="Pump", type="centrifugal")
            raise AssertionError("a family without a mapping must not be routed")
        except KeyError:
            pass
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
        ], w, **SWING)
        needed = {o["ruleId"] for o in out if o.get("kind") == "evidence_needed"}
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert needed == {"9.5"}
        assert all(o["ruleStatus"] == "INSUFFICIENT_EVIDENCE" for o in out if o.get("kind") == "evidence_needed")
        assert "2.2" not in screened and "9.5" not in screened
    asyncio.run(main())


def test_order_document_lets_document_rules_be_screened_with_order_text():
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-order")
        w = {"tasks": [{"ruleId": "2.3", "title": "Pressure Class on body", "quote": "150 / 300 / 600 etc. matches PO", "modalities": ["photo", "video"], "features": []}]}
        seen = []
        original = orch.dispatch

        async def capture(c, items):
            seen.extend(rule for _, rule in items)
            return await original(c, items)
        orch.dispatch = capture
        await orch.dispatch_evidence(ctx, [{"mediaType": "photo", "eventId": "img-o", "path": "", "detectedComponents": ["body_markings"]}],
                                     w, order_context="WO-1 Class 150", **SWING)
        assert [r["ruleId"] for r in seen] == ["2.3"]
        assert seen[0]["orderContext"] == "WO-1 Class 150"
    asyncio.run(main())


def test_dispatch_video_uses_same_routing_and_skips_decided_rules():
    # Video segments route like photos; dynamic operation rules are
    # decidable from video, seat-test evidence is not; rules an earlier
    # item already decided are not re-screened from video.
    async def main():
        orch = Orchestrator(transport="local", max_retries=1)
        ctx = InspectionContext(session_id="insp-vid")
        w = wl.build_worklist("CVS6000_VALVE")
        out = await orch.dispatch_evidence(ctx, [
            {"mediaType": "video", "eventId": "vid-1", "path": "", "detectedComponents": ["full_valve"]},
        ], w, skip_rule_ids=["10.1"], **SWING)
        needed = {o["ruleId"] for o in out if o.get("kind") == "evidence_needed"}
        screened = {o.get("ruleId") for o in out if o.get("kind") != "evidence_needed"}
        assert "9.5" in needed
        assert screened and screened <= {"10.2", "10.4", "10.5", "10.6", "10.7", "9.1", "9.2", "9.4", "8.4"}
        assert any(e["event"] == "rule-already-decided" for e in ctx.log)
    asyncio.run(main())


def test_visual_routing_one_valve_mapping_with_subtypes():
    assert vr.CONFIG_PATH.name == "visual-routing.json"
    assert len(vr.MAPPINGS) == 1 and vr.MAPPINGS[0]["family"] == "Valve"
    swing = vr.get_mapping("Valve", "swing_check")
    ball = vr.get_mapping("valve", "Ball")
    swing_ids = {c["id"] for c in swing["components"]}
    ball_ids = {c["id"] for c in ball["components"]}
    assert {"lever_weight", "air_cushion"} <= swing_ids and not {"handwheel", "actuator"} & swing_ids
    assert {"handwheel", "actuator"} <= ball_ids and not {"lever_weight", "air_cushion"} & ball_ids
    for family, type_ in [("Valve", "diaphragm"), ("Pump", "centrifugal"), ("", "")]:
        try:
            vr.get_mapping(family, type_)
            raise AssertionError("unknown family/type must not resolve")
        except KeyError:
            pass


def test_relevant_components_only_those_with_session_rules():
    swing = vr.get_mapping("Valve", "swing_check")
    comps = vr.relevant_components(swing, [{"ruleId": "4.3"}, {"ruleId": "NP-001"}])
    assert {c["id"] for c in comps} == {"flange_face", "nameplate"}


def test_visual_routing_selects_only_detected_components():
    tasks = [
        {"ruleId": "4.3", "title": "Gasket face damage", "quote": "No radial scratches"},
        {"ruleId": "2.7", "title": "Identification plate fixed securely", "quote": "Not loose"},
        {"ruleId": "3.1", "title": "Cracks", "quote": "No crack-type defects allowed"},
    ]
    routed = vr.select_rules(tasks, ["flange_face"], "photo", vr.get_mapping("Valve", "swing_check"))
    assert [t["ruleId"] for t in routed["selected"]] == ["4.3"]
    assert routed["evidenceNeeded"] == [] and routed["skipped"] == []


def test_visual_routing_skips_document_rules_unless_critical():
    tasks = [
        {"ruleId": "2.2", "title": "Body material designation", "quote": "matches MTC and PO"},
        {"ruleId": "NP-003", "title": "Serial format", "quote": "must match work order. Else FAIL."},
        {"ruleId": "NP-001", "title": "Nameplate present", "quote": "nameplate must be present and stamped. Absent/unstamped = FAIL."},
    ]
    mapping = vr.get_mapping("Valve", "swing_check")
    routed = vr.select_rules(tasks, ["nameplate", "body_markings"], "photo", mapping)
    assert [t["ruleId"] for t in routed["skipped"]] == ["2.2"]
    assert [t["ruleId"] for t in routed["evidenceNeeded"]] == ["NP-003"]
    assert [t["ruleId"] for t in routed["selected"]] == ["NP-001"]
    with_order = vr.select_rules(tasks, ["nameplate", "body_markings"], "photo", mapping, order_document=True)
    assert [t["ruleId"] for t in with_order["selected"]] == ["2.2", "NP-003", "NP-001"]


def test_requirement_patterns_match_whole_words_only():
    m = vr.get_mapping("Valve", "swing_check")
    wo_r06 = {"ruleId": "WO-R06", "quote": "Nameplate exists and visibly matches WO-ARGUS-CVS48-001 / CVS48-AC-DEMO-002, size 48 in"}
    assert "measurement" not in vr.classify_rule(wo_r06, m)  # 'Cv' is not inside 'CVS48'
    assert "measurement" in vr.classify_rule({"ruleId": "NP-009", "quote": "Pos.7 Cv must equal work order Cv"}, m)
    assert "measurement" in vr.classify_rule({"ruleId": "4.5", "quote": "Correct number, dia, PCD"}, m)
