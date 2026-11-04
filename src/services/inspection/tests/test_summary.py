import meta_adapter


def _dossier():
    return {"inspection": {"name": "S2", "outcome": "FAIL", "lifecycleStatus": "COMPLETED", "partial": False},
            "baseline": {"cadName": "CVS 6000D", "family": "Valve", "type": "Swing check", "order": {"orderNumber": "WO-1"}},
            "geometry": {"status": "valid", "coverage": 0.95, "sha256": "x"},
            "findings": [{"ruleId": "WO-R03", "title": "Nameplate", "status": "FAIL", "quote": "q" * 900, "reason": "mismatch"},
                         {"ruleId": "4.1", "title": "Paint", "status": "NOT_INSPECTED", "quote": "", "reason": ""}],
            "incomplete": []}


def test_summary_input_is_slim():
    x = meta_adapter._summary_input(_dossier())
    assert [r["id"] for r in x["rules"]] == ["WO-R03"] and x["notInspected"] == ["4.1"]
    assert len(x["rules"][0]["rule"]) == 300 and "sha256" not in x["scan"]


def test_summarize_parses_and_guards_action(monkeypatch):
    monkeypatch.setattr(meta_adapter, "_configured", lambda: True)
    seen = {}
    def fake(model, content, instructions=None, timeout_s=None):
        seen["instructions"] = instructions
        return 'Sure: {"summary": "The nameplate disagrees with the order.", "action": "Ship it", "actionReason": "r", "nextSteps": ["a","b","c","d"]}'
    monkeypatch.setattr(meta_adapter, "_call_model", fake)
    out = meta_adapter.summarize_inspection(_dossier())
    assert out["summary"].startswith("The nameplate") and out["action"] == "Review before sign-off"
    assert len(out["nextSteps"]) == 3 and "Never change" in seen["instructions"]
