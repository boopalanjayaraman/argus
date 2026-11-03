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


def test_sam_stream_parsing_counts_boxes(monkeypatch):
    import io
    sse = (
        'data: {"type": "response.output_text.delta", "delta": "<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>"}\n'
        'data: {"type": "response.output_text.delta", "delta": "<|box;x1=5;y1=6;x2=7;y2=8;w=10;h=10|>"}\n'
        'data: {"type": "response.completed", "response": {"output_text": "<|box;duplicate|>" }}\n'
    )
    class Resp(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setenv("META_API_KEY", "test")
    monkeypatch.setattr(meta_adapter.urllib.request, "urlopen", lambda req, timeout=None: Resp(sse.encode()))
    monkeypatch.setattr(meta_adapter, "_media_content", lambda p, s, t: {"type": "input_image", "image_url": "x"})
    assert meta_adapter._sam_detect("/tmp/x.png", "image", "flange face") == 2
