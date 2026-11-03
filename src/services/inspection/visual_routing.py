"""Deterministic visual routing for inspection sessions.

SAM 3.1 detects components in a photo/video. This module — driven only by
src/reference-data/visual-routing.json, which holds one mapping per
equipment family with its subtypes listed together — decides which of the
session's applicable rules may be applied to that evidence:

- a rule whose component is not detected is not applied to this evidence;
- a rule that needs information outside the image (PO/MTC/datasheet,
  a measurement, a test record) is skipped for this evidence, unless it is
  critical, in which case it is reported as evidence-needed
  (INSUFFICIENT_EVIDENCE) instead of being screened;
- an uploaded order document satisfies the `document` need, so those
  rules are screened against the order text;
- every other routed rule is screened by the media models.

No LLM participates in routing. An unknown family/type raises KeyError:
it is never routed with another family's mapping.
"""
from __future__ import annotations
import json
import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
CONFIG_PATH = REPO_ROOT / "src/reference-data" / "visual-routing.json"

_cfg = json.loads(CONFIG_PATH.read_text())
MAPPINGS: list[dict] = _cfg["mappings"]
_DYNAMIC_VIDEO_CODES = {"8.2", "8.3", "8.4"}


def _norm(value: str) -> str:
    return (value or "").strip().lower().replace("-", "_").replace(" ", "_")


def get_mapping(family: str, type: str) -> dict:
    """The routing mapping for one equipment family/subtype: the family
    entry with its components narrowed to those the subtype has."""
    for m in MAPPINGS:
        types = {_norm(t) for t in m.get("types") or []}
        if _norm(m.get("family", "")) == _norm(family) and (_norm(type) in types or "*" in types):
            components = [c for c in m["components"]
                          if not c.get("types") or _norm(type) in {_norm(t) for t in c["types"]}]
            return {**m, "type": _norm(type), "components": components}
    raise KeyError(f"no visual routing mapping for family={family!r} type={type!r}")


def relevant_components(mapping: dict, tasks: list[dict]) -> list[dict]:
    """Only components that can route at least one of the session's tasks
    are worth a SAM prompt (each concept is one SAM request)."""
    codes = {t.get("ruleId") or t.get("code") for t in tasks}
    return [c for c in mapping["components"] if codes & set(c.get("ruleCodes") or [])]


def classify_rule(rule: dict, mapping: dict) -> list[str]:
    """External information a rule needs beyond the image itself."""
    code = rule.get("ruleId") or rule.get("code") or ""
    if code in set(mapping.get("visualOverrideCodes") or []):
        return []
    text = f"{rule.get('title', '')} {rule.get('quote', '')} {rule.get('text', '')}".lower()
    needs: list[str] = []
    for kind, patterns in (mapping.get("externalRequirementPatterns") or {}).items():
        if any(_pattern(p).search(text) for p in patterns):
            needs.append(kind)
    return needs


def _pattern(phrase: str) -> "re.Pattern[str]":
    """Whole-word match: 'Cv' must not match inside 'CVS48', 'dia' not
    inside 'radial'."""
    return re.compile(r"(?<![a-z0-9])" + re.escape(phrase.strip().lower()) + r"(?![a-z0-9])")


def is_critical(rule: dict, mapping: dict) -> bool:
    code = rule.get("ruleId") or rule.get("code") or ""
    quote = (rule.get("quote") or rule.get("text") or "")
    return code in set(mapping.get("criticalRuleCodes") or []) or "FAIL" in quote


def select_rules(tasks: list[dict], detected_component_ids: list[str], source: str,
                 mapping: dict, order_document: bool = False) -> dict:
    """Route worklist tasks for one evidence item.

    Returns {selected, evidenceNeeded, skipped} with reasons per rule."""
    wanted: set[str] = set()
    for comp in mapping["components"]:
        if comp["id"] in detected_component_ids:
            wanted.update(comp.get("ruleCodes") or [])
    selected, evidence_needed, skipped = [], [], []
    for task in tasks:
        code = task.get("ruleId") or task.get("code") or ""
        if code not in wanted:
            continue
        needs = classify_rule(task, mapping)
        if needs and source == "video" and code in _DYNAMIC_VIDEO_CODES:
            needs = [n for n in needs if n != "testRecord"]
        if order_document:
            needs = [n for n in needs if n != "document"]
        if not needs:
            selected.append(task)
        elif is_critical(task, mapping):
            evidence_needed.append({**task, "needs": needs,
                                    "reason": f"Needs {', '.join(needs)} evidence beyond this {source}; not decidable from the image alone."})
        else:
            skipped.append({**task, "needs": needs,
                            "reason": f"Skipped for this {source}: needs {', '.join(needs)} evidence."})
    return {"selected": selected, "evidenceNeeded": evidence_needed, "skipped": skipped}
