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
    reg = {"status": "valid", "fitness": 0.98, "surfaceCoverageFraction": 0.6}
    assert geometry_gate(reg, "mm") == "valid"
    assert geometry_gate(reg, None) == "insufficient"
    assert geometry_gate({**reg, "fitness": 0.5}, "mm") == "insufficient"
    assert geometry_gate({**reg, "surfaceCoverageFraction": 0.1}, "mm") == "insufficient"
    assert geometry_gate(None, "mm") == "insufficient"


PRE = [{"metric": "fitness", "min": 0.9}, {"metric": "surfaceCoverageFraction", "min": 0.8}]
GEO_001 = {"ruleId": "GEO-001", "modalities": ["pointcloud"], "applicability": "DEMO_ONLY", "threshold": PRE, "onFail": "INSUFFICIENT_EVIDENCE"}
GEO_002 = {"ruleId": "GEO-002", "modalities": ["pointcloud"], "applicability": "DEMO_ONLY", "prerequisites": PRE, "threshold": {"metric": "rmsDeviationMm", "max": 3.0}}


def _geo(**reg):
    return [{"kind": "geometry", "units": "mm", "registration": {"status": "valid", "fitness": 1.0, "surfaceCoverageFraction": 0.95, "rmsDeviationMm": 2.0, **reg}}]


def test_scan_rule_thresholds():
    assert evaluate_rule(GEO_002, _geo()) == "PASS"
    assert evaluate_rule(GEO_002, _geo(rmsDeviationMm=3.4)) == "FAIL"
    # prerequisites not met: not enough evidence, never PASS or FAIL
    assert evaluate_rule(GEO_002, _geo(surfaceCoverageFraction=0.6)) == "INSUFFICIENT_EVIDENCE"
    assert evaluate_rule(GEO_002, _geo(rmsDeviationMm=None)) == "INSUFFICIENT_EVIDENCE"
    assert evaluate_rule(GEO_002, [{"kind": "geometry", "registration": {"status": "insufficient"}}]) == "INSUFFICIENT_EVIDENCE"


def test_registration_quality_rule_fails_as_insufficient_not_fail():
    assert evaluate_rule(GEO_001, _geo()) == "PASS"
    assert evaluate_rule(GEO_001, _geo(surfaceCoverageFraction=0.7)) == "INSUFFICIENT_EVIDENCE"


def test_order_rule_severity_cap():
    warn_only = {**RULE, "ruleId": "WO-R02", "maxSeverity": "WARNING"}
    assert evaluate_rule(warn_only, [{"kind": "component_absent", "certainty": "observed"}]) == "WARNING"


def test_absent_component_fails_when_observed():
    assert evaluate_rule(RULE, [{"kind": "component_absent", "certainty": "observed", "notes": "no fasteners"}]) == "FAIL"


def test_absent_component_suspected_is_not_a_fail():
    assert evaluate_rule(RULE, [{"kind": "component_absent", "certainty": "suspected"}]) != "FAIL"
