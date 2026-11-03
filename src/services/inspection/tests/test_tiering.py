import sys, pathlib, asyncio
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import meta_adapter
from agents import VideoAgent, ImageAgent, InspectionContext

RULE_FLANGE = {"ruleId": "WO-R02", "modalities": ["photo", "video"], "features": ["inlet_flange_face"], "applicability": "APPROVED", "quote": "Examine flange faces"}
RULE_OTHER = {"ruleId": "WO-X", "modalities": ["photo"], "features": ["linkage"], "applicability": "APPROVED", "quote": "q"}

def test_escalation_trigger():
    assert meta_adapter.needs_review({"kind": "possible_surface_line", "status": "ok"}, RULE_OTHER) is True
    assert meta_adapter.needs_review({"kind": "visual", "certainty": "suspected", "status": "ok"}, RULE_OTHER) is True
    assert meta_adapter.needs_review({"kind": "visual", "certainty": "observed", "status": "ok"}, RULE_FLANGE) is True  # critical feature
    assert meta_adapter.needs_review({"kind": "visual", "certainty": "observed", "status": "ok"}, RULE_OTHER) is False
    assert meta_adapter.needs_review({"status": "unavailable"}, RULE_FLANGE) is False  # nothing to review yet

def test_agents_are_tier_specific():
    async def main():
        ctx = InspectionContext(session_id="insp-tier")
        v = await VideoAgent().run(ctx, {"mediaType": "video", "eventId": "v1", "path": ""}, RULE_FLANGE)
        assert v["tier"] == "screen" and "review" not in v  # video never escalates per-segment
        i = await ImageAgent().run(ctx, {"mediaType": "photo", "eventId": "i1", "path": ""}, RULE_FLANGE)
        assert i["tier"] == "screen"
        assert i["model"] == meta_adapter.SCREEN_MODEL
    asyncio.run(main())

def test_models_configurable():
    assert meta_adapter.SCREEN_MODEL  # muse-spark-1.3 default
    assert meta_adapter.REVIEW_MODEL  # flagship review tier, id confirmed at smoke test
    assert meta_adapter.SCREEN_MODEL != meta_adapter.REVIEW_MODEL
