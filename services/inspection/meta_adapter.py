"""Meta model adapters (Muse Spark visual + SAM 3.1 segmentation).

Reads credentials from the server environment only (META_API_KEY, see
.env.template). Without credentials these return a structured 'unavailable'
result — the coordinator then leaves rules INSUFFICIENT_EVIDENCE. They never
fabricate an observation. Fill .env and set META_ADAPTER_LIVE=1 after a
successful smoke test against the real endpoint for this account.
"""
from __future__ import annotations
import os

MODEL = os.environ.get("META_MODEL", "muse-spark-1.3")
SAM_MODEL = os.environ.get("SAM_MODEL", "sam-3-1")


def _configured() -> bool:
    return bool(os.environ.get("META_API_KEY")) and os.environ.get("META_ADAPTER_LIVE") == "1"


def visual_observation(evidence_path: str, rule: dict) -> dict:
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.template)", "model": MODEL}
    # Live call site: POST the actual media + pinned rule quote to the Meta
    # Model API and validate the reply against the observation schema.
    # Kept gated until account endpoint/structured-output shape is smoke-tested.
    return {"status": "unavailable", "reason": "live endpoint not yet smoke-tested for this account", "model": MODEL}


def segment(evidence_path: str, feature_id: str) -> dict:
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.template)", "model": SAM_MODEL}
    return {"status": "unavailable", "reason": "live endpoint not yet smoke-tested for this account", "model": SAM_MODEL}
