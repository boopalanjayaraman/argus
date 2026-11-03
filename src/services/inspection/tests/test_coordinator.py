import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import coordinator
from coordinator import select_tools, evaluate_rule, aggregate_outcome, geometry_gate

RULE = {"ruleId": "WO-R02", "modalities": ["photo", "pointcloud"], "features": ["inlet_flange_face"], "applicability": "APPROVED"}

def test_select_tools():
    assert "open3d_geometry" in select_tools({"mediaType": "pointcloud"}, RULE)
    assert "muse_spark_visual" in select_tools({"mediaType": "photo"}, RULE)
    assert select_tools({"mediaType": "photo"}, {"modalities": []}) == []

def test_hairline_is_warning_not_fail():
    assert evaluate_rule(RULE, [{"kind": "possible_surface_line"}]) == "WARNING"

def test_geometry_without_valid_registration_is_insufficient():
    obs = [{"kind": "geometry", "registration": {"status": "invalid"}, "measurement": {"valueMm": 9}}]
    assert evaluate_rule(RULE, obs) == "INSUFFICIENT_EVIDENCE"

def test_outcome_matrix():
    assert aggregate_outcome(["PASS", "FAIL"]) == "FAIL"
    assert aggregate_outcome(["PASS", "NOT_INSPECTED"]) == "INCONCLUSIVE"
    assert aggregate_outcome(["PASS", "WARNING"]) == "WARNING"
    assert aggregate_outcome(["PASS", "PASS"]) == "PASS"
    assert aggregate_outcome(["PASS"], terminated=True) == "INCONCLUSIVE"

def test_geometry_gate():
    assert geometry_gate({"status": "valid", "rmseMm": 0.8, "surfaceCoverageFraction": 0.6}, "mm") == "valid"
    assert geometry_gate({"status": "valid", "rmseMm": 0.8, "surfaceCoverageFraction": 0.6}, None) == "insufficient"
    assert geometry_gate(None, "mm") == "insufficient"


def test_absent_component_fails_when_observed():
    assert evaluate_rule(RULE, [{"kind": "component_absent", "certainty": "observed", "notes": "no fasteners"}]) == "FAIL"


def test_absent_component_suspected_is_not_a_fail():
    assert evaluate_rule(RULE, [{"kind": "component_absent", "certainty": "suspected"}]) != "FAIL"
