"""Meta Model API adapter (live).

Boundary (Argus_Agentic_Architecture §5): media models return OBSERVATIONS
only — never verdicts, tolerances, citations or evidence. Rule verdicts are
decided by coordinator.py from these observations.

API: Meta Model API, Responses API at https://api.meta.ai/v1
(POST /responses, Bearer META_API_KEY). Video goes through the Files API
(POST /files, purpose=user_data) and is referenced by file_id.
Models (verified live 2026-11-03 via GET /v1/models):
  Tier 1 screen:  muse-spark-1.3   (META_SCREEN_MODEL)
  Tier 2 review:  muse-wonder-1.0  (META_REVIEW_MODEL)
  Segmentation:   sam-3.1          (META_SAM_MODEL; not yet wired)
"""
from __future__ import annotations
import base64
import json
import os
import time
import urllib.error
import urllib.request
import uuid

SCREEN_MODEL = os.environ.get("META_SCREEN_MODEL", "muse-spark-1.3")
REVIEW_MODEL = os.environ.get("META_REVIEW_MODEL", "muse-wonder-1.0")
SAM_MODEL = os.environ.get("META_SAM_MODEL", "sam-3.1")
API_BASE = os.environ.get("META_API_BASE", "https://api.meta.ai/v1")

_KINDS = {"component_present", "component_absent", "possible_surface_line", "no_component"}
_CERTAINTIES = {"observed", "suspected", "unknown"}

_SYSTEM = (
    "You are a screening instrument for industrial valve inspection. You return "
    "observations only, never verdicts. Answer ONLY with one JSON object: "
    '{"kind": "component_present" | "component_absent" | "possible_surface_line" | "no_component", '
    '"certainty": "observed" | "suspected" | "unknown", "notes": "<short factual note>"}. '
    "component_present: the checked feature is visible and appears as specified. "
    "component_absent: the feature area is clearly visible and the feature is missing or wrong. "
    "possible_surface_line: a visible surface indication, damage, or illegible/missing marking that a human should review. "
    "no_component: the checked feature is not visible in this evidence. "
    "Never invent markings, values, or tolerances that are not visible."
)


def _configured() -> bool:
    return bool(os.environ.get("META_API_KEY")) and os.environ.get("META_ADAPTER_LIVE") == "1"


def _post(path: str, payload: dict, timeout_s: float) -> dict:
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read())


def _upload_file(path: str, timeout_s: float) -> str:
    """Files API upload (purpose=user_data); returns the file_id."""
    boundary = f"----argus{uuid.uuid4().hex}"
    filename = os.path.basename(path) or "evidence.mp4"
    with open(path, "rb") as fh:
        data = fh.read()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nuser_data\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        API_BASE + "/files",
        data=body,
        headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read())["id"]


def _call_model(model: str, content: list[dict]) -> str:
    """One Responses call with retries on 429/5xx/network errors."""
    timeout_s = float(os.environ.get("META_TIMEOUT_MS", "120000")) / 1000.0
    retries = int(os.environ.get("META_MAX_RETRIES", "2"))
    payload = {"model": model, "instructions": _SYSTEM,
               "input": [{"type": "message", "role": "user", "content": content}]}
    last_error = ""
    for attempt in range(retries + 1):
        try:
            body = _post("/responses", payload, timeout_s)
            for item in body.get("output", []):
                if item.get("type") == "message":
                    for block in item.get("content", []):
                        if block.get("type") == "output_text":
                            return block["text"]
            raise ValueError("response contained no output_text")
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read().decode()[:200]}"
            if exc.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise RuntimeError(last_error) from exc
        except Exception as exc:  # network/timeout: retry, then surface
            last_error = str(exc)
            if attempt == retries:
                raise
        time.sleep(1.5 * (2 ** attempt))
    raise RuntimeError(last_error)


def _parse_observation(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {"kind": "no_component", "certainty": "unknown", "notes": f"unparseable model output: {text[:120]}"}
    try:
        obj = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {"kind": "no_component", "certainty": "unknown", "notes": f"unparseable model output: {text[:120]}"}
    kind = obj.get("kind") if obj.get("kind") in _KINDS else "no_component"
    certainty = obj.get("certainty") if obj.get("certainty") in _CERTAINTIES else "unknown"
    return {"kind": kind, "certainty": certainty, "notes": str(obj.get("notes") or "")[:300]}


def _media_content(path: str, source: str, timeout_s: float) -> dict:
    if source == "video":
        return {"type": "input_file", "file_id": _upload_file_cached(path, timeout_s)}
    mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    with open(path, "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode()
    return {"type": "input_image", "image_url": f"data:{mime};base64,{encoded}"}


def _visual(model: str, evidence_path: str, rule: dict, source: str) -> dict:
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.example)", "model": model}
    if not evidence_path or not os.path.exists(evidence_path):
        return {"status": "unavailable", "reason": f"evidence file not available to agent: {evidence_path}", "model": model}
    timeout_s = float(os.environ.get("META_TIMEOUT_MS", "120000")) / 1000.0
    features = ", ".join(rule.get("features") or []) or rule.get("title", "")
    prompt = (
        f"Inspection check: {rule.get('title', '')}. Acceptance (pinned rule): "
        f"\"{rule.get('quote', '')}\" Features to look for: {features}. "
        "Judge only what is visible in this evidence."
    )
    try:
        text = _call_model(model, [
            {"type": "input_text", "text": prompt},
            _media_content(evidence_path, source, timeout_s),
        ])
    except Exception as exc:
        return {"status": "unavailable", "reason": f"Meta API call failed: {exc}", "model": model}
    return {**_parse_observation(text), "model": model}


def needs_review(screen: dict, rule: dict) -> bool:
    """Tier 2 escalates flagged indications, uncertain screens, and rules
    whose features are critical (safety/high-consequence checks)."""
    if not screen or screen.get("status") == "unavailable":
        return False
    if screen.get("kind") in ("possible_surface_line", "component_absent"):
        return True
    if screen.get("certainty") in ("suspected", "unknown"):
        return True
    critical = {"inlet_flange_face", "outlet_flange_face", "flange_face", "bonnet_joint", "nameplate"}
    features = set(rule.get("features") or [])
    return bool(features & critical) or any("flange" in f for f in features)


_FILE_ID_CACHE: dict[str, str] = {}


def _upload_file_cached(path: str, timeout_s: float) -> str:
    key = f"{path}:{os.path.getsize(path)}:{int(os.path.getmtime(path))}"
    if key not in _FILE_ID_CACHE:
        _FILE_ID_CACHE[key] = _upload_file(path, timeout_s)
    return _FILE_ID_CACHE[key]


def _sam_detect(path: str, source: str, concept: str) -> int:
    """One SAM 3.1 concept prompt; returns the number of boxes found."""
    timeout_s = float(os.environ.get("META_TIMEOUT_MS", "120000")) / 1000.0
    if source == "video":
        media = {"type": "input_file", "file_id": _upload_file_cached(path, timeout_s)}
    else:
        media = _media_content(path, source, timeout_s)
    payload = {"model": SAM_MODEL, "stream": True,
               "input": [{"type": "message", "role": "user", "content": [
                   {"type": "input_text", "text": concept}, media]}]}
    req = urllib.request.Request(API_BASE + "/responses", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}",
                                          "Content-Type": "application/json"}, method="POST")
    text_parts: list[str] = []
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:])
            except json.JSONDecodeError:
                continue
            if event.get("type") == "response.output_text.delta":
                text_parts.append(event.get("delta", ""))
    return "".join(text_parts).count("<|box;")


def detect_components(evidence_path: str, source: str, components: list[dict]) -> list[dict]:
    """SAM 3.1 component detection: which configured valve components are
    present in this evidence. Returns [{id, prompt, boxes}] for matches."""
    if not _configured():
        return []
    if not evidence_path or not os.path.exists(evidence_path):
        return []
    found = []
    for comp in components:
        try:
            boxes = _sam_detect(evidence_path, source, comp["samPrompt"])
        except Exception:
            boxes = 0
        if boxes:
            found.append({"id": comp["id"], "prompt": comp["samPrompt"], "boxes": boxes})
    return found


def screen_visual(evidence_path: str, rule: dict, source: str = "image") -> dict:
    """Tier 1 (Muse Spark): screen one segment/photo against one pinned rule."""
    return _visual(SCREEN_MODEL, evidence_path, rule, source)


def review_visual(evidence_path: str, rule: dict, screen: dict | None = None, source: str = "image") -> dict:
    """Tier 2 (Muse Wonder): deeper review of flagged/high-stakes items.
    An additional observation, never a replacement verdict."""
    if isinstance(screen, str):  # tolerate the legacy positional call
        source, screen = screen, None
    return _visual(REVIEW_MODEL, evidence_path, rule, source)


def segment_visual(evidence_path: str, prompt: str) -> dict:
    """SAM 3.1 segmentation: not yet wired into the verdict path."""
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1 (see .env.example)", "model": SAM_MODEL}
    return {"status": "unavailable", "reason": "segmentation not yet wired (observations flow does not consume masks)", "model": SAM_MODEL}
