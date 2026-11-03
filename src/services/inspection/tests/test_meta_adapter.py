import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import meta_adapter


def test_parse_observation_validates_enums():
    obs = meta_adapter._parse_observation('{"kind": "component_present", "certainty": "observed", "notes": "bolts visible"}')
    assert obs == {"kind": "component_present", "certainty": "observed", "notes": "bolts visible"}


def test_parse_observation_rejects_invented_kinds():
    obs = meta_adapter._parse_observation('{"kind": "FAIL", "certainty": "sure", "notes": "bad"}')
    assert obs["kind"] == "no_component" and obs["certainty"] == "unknown"


def test_parse_observation_extracts_json_from_prose():
    obs = meta_adapter._parse_observation('Result: {"kind": "possible_surface_line", "certainty": "suspected", "notes": "scratch"} done')
    assert obs["kind"] == "possible_surface_line"


def test_unavailable_without_live_flag(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "x")
    monkeypatch.delenv("META_ADAPTER_LIVE", raising=False)
    out = meta_adapter.screen_visual("/tmp/none.png", {"title": "t", "quote": "q"})
    assert out["status"] == "unavailable"


FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "sam_stream_bonnet_bolts.json"


def test_sam_stream_parsing_real_recording():
    # A real SAM 3.1 stream ("bolts on valve bonnet" on a CVS 6000D photo),
    # parsed with Meta's meta_sam_parser into boxes + mask SVG paths.
    import json
    events = json.loads(FIXTURE.read_text())
    out = meta_adapter.parse_sam_events(events, min_confidence=0.0)
    assert out["outcome"] == "completed"
    assert out["objects"], "recording contains detections"
    for obj in out["objects"]:
        box = obj["box"]
        assert box["right"] > box["left"] and box["bottom"] > box["top"]
        assert 0.0 <= obj["confidence"] <= 1.0
        assert obj["mask"]["bounds"]["left"] == box["left"]
        assert obj["mask"]["svgPath"].startswith("M")
    strict = meta_adapter.parse_sam_events(events, min_confidence=1.01)
    assert strict["objects"] == []


def test_detect_components_runs_concepts_in_parallel_and_reports_errors(monkeypatch, tmp_path):
    import threading, time
    photo = tmp_path / "p.jpg"; photo.write_bytes(b"x")
    monkeypatch.setenv("META_API_KEY", "k"); monkeypatch.setenv("META_ADAPTER_LIVE", "1")
    active, peak = [0], [0]
    lock = threading.Lock()

    def fake(path, source, concept):
        with lock:
            active[0] += 1; peak[0] = max(peak[0], active[0])
        time.sleep(0.05)
        with lock:
            active[0] -= 1
        if concept == "broken":
            raise RuntimeError("HTTP 500")
        return {"objects": [{"box": {"left": 0, "top": 0, "right": 2, "bottom": 2}, "confidence": 0.9}] if concept == "metal nameplate" else [],
                "width": 10, "height": 10, "seconds": 0.05}
    monkeypatch.setattr(meta_adapter, "segment_concept", fake)
    comps = [{"id": "nameplate", "samPrompt": "metal nameplate"}, {"id": "flange_face", "samPrompt": "flange face"}, {"id": "x", "samPrompt": "broken"}]
    out = {c["id"]: c for c in meta_adapter.detect_components(str(photo), "photo", comps)}
    assert out["nameplate"]["boxes"] == 1 and out["flange_face"]["boxes"] == 0
    assert out["x"]["boxes"] == 0 and "HTTP 500" in out["x"]["error"]
    assert peak[0] > 1  # concepts ran concurrently


def test_order_context_reaches_the_prompt(monkeypatch, tmp_path):
    photo = tmp_path / "p.png"; photo.write_bytes(b"x")
    monkeypatch.setenv("META_API_KEY", "k"); monkeypatch.setenv("META_ADAPTER_LIVE", "1")
    seen = {}
    monkeypatch.setattr(meta_adapter, "_media_content", lambda p, s, t, r=None: {"type": "input_image", "image_url": "x"})
    monkeypatch.setattr(meta_adapter, "_call_model", lambda model, content: seen.setdefault("text", content[0]["text"]) and '{"kind":"component_present","certainty":"observed","notes":"ok"}')
    meta_adapter.screen_visual(str(photo), {"title": "Pressure class", "quote": "matches PO", "orderContext": "WO-1 Class 150"})
    assert "WO-1 Class 150" in seen["text"]


def test_order_rules_extracted_from_work_order_pdf():
    import documents
    pdf = pathlib.Path(__file__).resolve().parents[4] / "src/reference-data/cvs6000d-48-demo/customer-documents/Argus_CVS6000D_48in_Work_Order.pdf"
    d = documents.describe(str(pdf))
    assert d["orderNumber"] == "WO-ARGUS-CVS48-001"
    rules = {r["ruleId"]: r for r in d["rules"]}
    assert list(rules) == [f"WO-R0{i}" for i in range(1, 8)]
    assert rules["WO-R02"]["quote"].startswith("Machined sealing faces show no suspected crack-like linear indication")
    assert rules["WO-R02"]["maxSeverity"] == "WARNING" and rules["WO-R03"]["maxSeverity"] == "FAIL"
    assert "pointcloud" in rules["WO-R01"]["modalities"]
    # WO-R07 continues across a page break and needs test records
    assert rules["WO-R07"]["quote"].endswith("Without actual test data result is NOT EVALUATED.")
    assert rules["WO-R07"]["applicability"] == "REFERENCE_ONLY"
