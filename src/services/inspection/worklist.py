"""Session worklist: what each sub-agent is tasked to look for.

Built at session creation from the pinned rule pack (library -> valve type
-> customer spec cascade lives in the Argus API / PRD-06; this module loads
the resulting applicable set). Media agents never decide rules and never
issue verdicts — but they are never rule-blind either: every dispatch
carries a TaskEnvelope with the pinned rule, its feature, its quote, and
its approved threshold (when one exists).
"""
from __future__ import annotations
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RULES = REPO_ROOT / "src/reference-data" / "rule-library.json"


def load_rules(rules_path: str | Path | None = None) -> list[dict]:
    pack = json.loads(Path(rules_path or DEFAULT_RULES).read_text())
    return pack["rules"] if isinstance(pack, dict) else pack


def build_worklist(model_id: str, rules_path: str | Path | None = None) -> dict:
    """Applicable inspection tasks for a session on this CAD model."""
    rules = load_rules(rules_path)
    tasks, excluded = [], []
    for r in rules:
        if r.get("applicability") == "REFERENCE_ONLY" or not r.get("modalities"):
            excluded.append({"ruleId": r["ruleId"], "reason": "reference-only or no visual/geometry modality"})
            continue
        tasks.append({
            "ruleId": r["ruleId"],
            "title": r.get("title"),
            "section": r.get("section"),
            "quote": r.get("quote"),
            "source": r.get("source"),
            "page": r.get("page"),
            "features": r.get("features", []),
            "modalities": r.get("modalities", []),
            "thresholdMm": r.get("thresholdMm"),
            "applicability": r.get("applicability"),
            "model_id": model_id,
        })
    return {"model_id": model_id, "tasks": tasks, "excluded": excluded,
            "counts": {"library": len(rules), "tasks": len(tasks), "excluded": len(excluded)}}


def associate(evidence: dict, worklist: dict) -> list[dict]:
    """Evidence -> candidate task(s): modality must match the rule, and when
    the evidence carries a feature hint, the rule must cover that feature.
    Association proposes; agents observe; the gate decides."""
    media = evidence.get("mediaType")
    feature = evidence.get("featureId") or evidence.get("feature")
    out = []
    for task in worklist.get("tasks", []):
        if media not in task.get("modalities", []):
            continue
        if feature and task.get("features") and feature not in task["features"]:
            continue
        out.append(task)
    return out


def task_envelope(session_id: str, evidence: dict, task: dict) -> dict:
    """What a sub-agent is told to look for. Contains the pinned rule context
    and CAD reference pointer — never a desired verdict."""
    return {
        "sessionId": session_id,
        "evidence": evidence,
        "rule": task,
        "lookFor": {
            "ruleId": task["ruleId"],
            "feature": (task.get("features") or [None])[0],
            "features": task.get("features", []),
            "acceptanceQuote": task.get("quote"),
            "thresholdMm": task.get("thresholdMm"),
        },
    }
