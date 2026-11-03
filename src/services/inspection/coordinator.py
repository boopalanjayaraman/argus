"""One bounded Inspection Coordinator: tool selection + deterministic rule gate.

Agentic part: choose which tool(s) to run per evidence event.
Deterministic part: rule verdicts, outcome aggregation, geometry gating.
No verdict is ever invented: missing registration/units/coverage -> INSUFFICIENT_EVIDENCE.
"""
from __future__ import annotations

RULE_STATUSES = {"NOT_INSPECTED", "ANALYZING", "PASS", "WARNING", "FAIL", "INSUFFICIENT_EVIDENCE", "NOT_APPLICABLE"}


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


def evaluate_rule(rule: dict, observations: list[dict]) -> str:
    """Deterministic gate over typed observations."""
    if rule.get("applicability") == "REFERENCE_ONLY" or not rule.get("modalities"):
        return "NOT_APPLICABLE"
    if not observations:
        return "NOT_INSPECTED"
    for obs in observations:
        if obs.get("kind") == "geometry":
            reg = obs.get("registration") or {}
            tol = rule.get("thresholdMm")
            if reg.get("status") != "valid" or tol is None:
                continue  # geometry cannot decide this rule yet
            dev = obs.get("measurement", {}).get("valueMm")
            if dev is not None:
                return "FAIL" if abs(dev) > tol else "PASS"
        if obs.get("kind") == "possible_surface_line":
            return "WARNING"  # visual indication -> review, never certified FAIL
        if obs.get("kind") == "component_present" and obs.get("certainty") == "observed":
            return "PASS"
        if obs.get("kind") == "component_absent" and obs.get("certainty") == "observed":
            return "FAIL"  # feature clearly visible-area absent: a genuine visual fail
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
    """Return 'valid' only when a mm claim is defensible."""
    if units not in ("mm", "millimeter", "millimeters"):
        return "insufficient"
    if not registration or registration.get("status") != "valid":
        return "insufficient"
    if registration.get("rmseMm") is None or registration["rmseMm"] > 2.0:
        return "insufficient"
    if (registration.get("surfaceCoverageFraction") or 0) < 0.3:
        return "insufficient"
    return "valid"
