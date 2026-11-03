"""One bounded Inspection Coordinator: tool selection + deterministic rule gate.

Agentic part: choose which tool(s) to run per evidence event.
Deterministic part: rule verdicts, outcome aggregation, geometry gating.
No verdict is ever invented: missing registration/units/coverage -> INSUFFICIENT_EVIDENCE.
"""
from __future__ import annotations
import os

RULE_STATUSES = {"NOT_INSPECTED", "ANALYZING", "PASS", "WARNING", "FAIL", "INSUFFICIENT_EVIDENCE", "NOT_APPLICABLE"}

# Registration quality a scan must reach before any geometric rule may be
# decided from it (Agentic Architecture §5: units + validated registration).
GEO_MIN_FITNESS = float(os.environ.get("GEO_MIN_FITNESS", "0.9"))
GEO_MIN_COVERAGE = float(os.environ.get("GEO_MIN_COVERAGE", "0.3"))


def select_tools(evidence: dict, rule: dict) -> list[str]:
    """Coordinator decision: which tools are worth running for this evidence/rule pair."""
    tools: list[str] = []
    modalities = set(rule.get("modalities", []))
    media = evidence.get("mediaType")
    if media in ("photo", "video") and media in modalities:
        tools.append("muse_spark_visual")
        if rule.get("features"):
            tools.append("sam_segmentation")
    if media == "pointcloud" and "pointcloud" in modalities:
        tools.append("open3d_geometry")
    return tools


def _cap(rule: dict, status: str) -> str:
    """A rule that prints its own maximum severity (an order rule marked
    'WARNING / QC review') is never escalated beyond it."""
    if status == "FAIL" and rule.get("maxSeverity") == "WARNING":
        return "WARNING"
    return status


def _holds(reg: dict, cond: dict) -> bool | None:
    value = reg.get(cond.get("metric"))
    if value is None:
        return None
    if "max" in cond and value > cond["max"]:
        return False
    if "min" in cond and value < cond["min"]:
        return False
    return True


def _as_list(value) -> list[dict]:
    return [] if not value else (value if isinstance(value, list) else [value])


def _geometry_status(rule: dict, obs: dict, units: str | None = "mm") -> str | None:
    """Decide a scan rule from a geometry observation, or None if it can't.
    Only rules carrying an approved threshold (rule metadata, never a model)
    are decided: threshold = {"metric": <registration field>, "max"|"min": v}
    or a list of them; prerequisites (same shape) must hold first or the rule
    is INSUFFICIENT_EVIDENCE; onFail overrides FAIL for registration-quality
    rules whose failure means 'not enough evidence', not 'bad part'."""
    reg = obs.get("registration") or {}
    thresholds = _as_list(rule.get("threshold"))
    if thresholds:
        if geometry_gate(reg, units or obs.get("units") or "mm") != "valid":
            return "INSUFFICIENT_EVIDENCE"
        if any(_holds(reg, c) is not True for c in _as_list(rule.get("prerequisites"))):
            return "INSUFFICIENT_EVIDENCE"
        results = [_holds(reg, c) for c in thresholds]
        if any(r is None for r in results):
            return "INSUFFICIENT_EVIDENCE"
        return "PASS" if all(results) else rule.get("onFail", "FAIL")
    tol = rule.get("thresholdMm")
    dev = (obs.get("measurement") or {}).get("valueMm")
    if tol is None or dev is None or geometry_gate(reg, units or "mm") != "valid":
        return None  # geometry cannot decide this rule yet
    return "FAIL" if abs(dev) > tol else "PASS"


def evaluate_rule(rule: dict, observations: list[dict]) -> str:
    """Deterministic gate over typed observations."""
    if rule.get("applicability") == "REFERENCE_ONLY" or not rule.get("modalities"):
        return "NOT_APPLICABLE"
    if not observations:
        return "NOT_INSPECTED"
    for obs in observations:
        if obs.get("kind") == "geometry":
            status = _geometry_status(rule, obs)
            if status:
                return _cap(rule, status)
            continue
        if obs.get("kind") == "possible_surface_line":
            return "WARNING"  # visual indication -> review, never certified FAIL
        if obs.get("kind") == "component_present" and obs.get("certainty") == "observed":
            return "PASS"
        if obs.get("kind") == "component_absent" and obs.get("certainty") == "observed":
            return _cap(rule, "FAIL")  # feature clearly visible-area absent: a genuine visual fail
    return "INSUFFICIENT_EVIDENCE"


def aggregate_outcome(rule_statuses: list[str], terminated: bool = False) -> str:
    if "FAIL" in rule_statuses:
        return "FAIL"
    applicable = [s for s in rule_statuses if s != "NOT_APPLICABLE"]
    if terminated:
        return "INCONCLUSIVE"
    if any(s in ("NOT_INSPECTED", "INSUFFICIENT_EVIDENCE", "ANALYZING") for s in applicable):
        return "INCONCLUSIVE" if applicable else "PENDING"
    if "WARNING" in applicable:
        return "WARNING"
    return "PASS" if applicable else "PENDING"


def geometry_gate(registration: dict | None, units: str | None) -> str:
    """Return 'valid' only when a mm claim is defensible: known units, a
    registration the tool marked valid, enough of the scan matched to the
    CAD (ICP fitness) and enough of the CAD surface seen (coverage)."""
    if units not in ("mm", "millimeter", "millimeters"):
        return "insufficient"
    if not registration or registration.get("status") != "valid":
        return "insufficient"
    if (registration.get("fitness") or 0) < GEO_MIN_FITNESS:
        return "insufficient"
    if (registration.get("surfaceCoverageFraction") or 0) < GEO_MIN_COVERAGE:
        return "insufficient"
    return "valid"
