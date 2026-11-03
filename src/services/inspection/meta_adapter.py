"""Tiered Meta model adapters — agent-specific routing.

Tier 1 (screen): fast multimodal model screens ALL video segments and
  photographs. Cheap triage: candidate / nothing-visible / unknown.
Tier 2 (review): flagship reasoning model reviews only flagged or
  high-stakes items (suspected indication, low certainty, critical
  features). Low volume, high consequence.
Deterministic layers are never routed to a model: point-cloud geometry
(Open3D/ICP), the rule gate, and dossier numbers stay code.

Credentials from the server environment only (META_API_KEY, see
.env.example). Without credentials every call returns structured
'unavailable' — the gate then yields INSUFFICIENT_EVIDENCE. Live calls stay
gated behind META_ADAPTER_LIVE=1 until the account endpoint and each
model's multimodal/structured-output support is smoke-tested; the review
model id in particular must be confirmed on the account (do not assume a
version string). Model outputs are observations, never verdicts.
"""
from __future__ import annotations
import os

SCREEN_MODEL = os.environ.get("META_SCREEN_MODEL") or os.environ.get("META_MODEL", "muse-spark-1.3")
REVIEW_MODEL = os.environ.get("META_REVIEW_MODEL", "muse-wonder")
SAM_MODEL = os.environ.get("SAM_MODEL", "sam-3-1")

# Features whose photographs always get flagship review (low count, high consequence).
CRITICAL_FEATURES = {"inlet_flange_face", "outlet_flange_face", "nameplate", "bonnet", "body"}


def _configured() -> bool:
    return bool(os.environ.get("META_API_KEY")) and os.environ.get("META_ADAPTER_LIVE") == "1"


def _unavailable(model: str, tier: str) -> dict:
    return {"status": "unavailable", "tier": tier,
            "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.example)", "model": model}


def screen_visual(evidence_path: str, rule: dict, source: str = "photo") -> dict:
    """Tier 1: fast multimodal screening of one segment/photo + pinned rule."""
    if not _configured():
        return _unavailable(SCREEN_MODEL, "screen")
    return {"status": "unavailable", "tier": "screen", "model": SCREEN_MODEL,
            "reason": "live endpoint not yet smoke-tested for this account"}


def review_visual(evidence_path: str, rule: dict, screen_observation: dict) -> dict:
    """Tier 2: flagship review of a flagged/high-stakes item."""
    if not _configured():
        return _unavailable(REVIEW_MODEL, "review")
    return {"status": "unavailable", "tier": "review", "model": REVIEW_MODEL,
            "reason": "review model id / multimodal support not yet smoke-tested for this account"}


def needs_review(screen_observation: dict, rule: dict) -> bool:
    """Deterministic escalation trigger: suspected indication, low/unknown
    certainty, or a critical feature — never model self-selection."""
    if screen_observation.get("kind") in ("possible_surface_line", "possible_indication"):
        return True
    if screen_observation.get("certainty") in ("suspected", "unknown", "low", None):
        # An unavailable screen has nothing to review yet; escalate only real observations.
        if screen_observation.get("status") == "unavailable":
            return False
        return True
    features = set(rule.get("features") or [])
    return bool(features & CRITICAL_FEATURES) and screen_observation.get("status") not in ("unavailable",)


def segment(evidence_path: str, feature_id: str) -> dict:
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.example)", "model": SAM_MODEL}
    return {"status": "unavailable", "reason": "live endpoint not yet smoke-tested for this account", "model": SAM_MODEL}
