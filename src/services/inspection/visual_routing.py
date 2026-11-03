"""Deterministic visual routing for inspection sessions.

SAM 3.1 detects components in a photo/video. This module — driven only by
src/reference-data/visual-routing.json, which holds one mapping per
equipment family/type — decides which of the applicable library rules
may be applied to that evidence:

- a rule whose component is not detected is not applied to this evidence;
- a rule that needs information outside the image (PO/MTC/datasheet,
  a measurement, a test record) is skipped for this evidence, unless it is
  critical, in which case it is reported as evidence-needed
  (INSUFFICIENT_EVIDENCE) instead of being screened;
- every other routed rule is screened by the media models.

No LLM participates in routing.
"""
from __future__ import annotations
import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
CONFIG_PATH = REPO_ROOT / "src/reference-data" / "visual-routing.json"

_cfg = json.loads(CONFIG_PATH.read_text())
MAPPINGS: list[dict] = _cfg["mappings"]
DEFAULT_FAMILY, DEFAULT_TYPE = "Valve", "ball"
_DYNAMIC_VIDEO_CODES = {"8.2", "8.3", "8.4"}


def get_mapping(family: str = DEFAULT_FAMILY, type: str = DEFAULT_TYPE) -> dict:
    """The routing mapping for one equipment family/type."""
    for m in MAPPINGS:
        if m.get("family") == family and m.get("type") == type:
            return m
    raise KeyError(f"no visual routing mapping for family={family!r} type={type!r}")


_DEFAULT = get_mapping()
COMPONENTS: list[dict] = _DEFAULT["components"]


def classify_rule(rule: dict, mapping: dict | None = None) -> list[str]:
    """External information a rule needs beyond the image itself."""
    mapping = mapping or _DEFAULT
    code = rule.get("ruleId") or rule.get("code") or ""
    if code in set(mapping.get("visualOverrideCodes") or []):
        return []
    text = f"{rule.get('title', '')} {rule.get('quote', '')} {rule.get('text', '')}".lower()
    needs: list[str] = []
    for kind, patterns in (mapping.get("externalRequirementPatterns") or {}).items():
        if any(p.lower() in text for p in patterns):
            needs.append(kind)
    return needs


def is_critical(rule: dict, mapping: dict | None = None) -> bool:
    mapping = mapping or _DEFAULT
    code = rule.get("ruleId") or rule.get("code") or ""
    quote = (rule.get("quote") or rule.get("text") or "")
    return code in set(mapping.get("criticalRuleCodes") or []) or "FAIL" in quote


def select_rules(tasks: list[dict], detected_component_ids: list[str], source: str,
                 family: str = DEFAULT_FAMILY, type: str = DEFAULT_TYPE,
                 mapping: dict | None = None) -> dict:
    """Route worklist tasks for one evidence item.

    Returns {selected, evidenceNeeded, skipped} with reasons per rule."""
    mapping = mapping or get_mapping(family, type)
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
        if not needs:
            selected.append(task)
        elif is_critical(task, mapping):
            evidence_needed.append({**task, "needs": needs,
                                    "reason": f"Needs {', '.join(needs)} evidence beyond this {source}; not decidable from the image alone."})
        else:
            skipped.append({**task, "needs": needs,
                            "reason": f"Skipped for this {source}: needs {', '.join(needs)} evidence."})
    return {"selected": selected, "evidenceNeeded": evidence_needed, "skipped": skipped}
