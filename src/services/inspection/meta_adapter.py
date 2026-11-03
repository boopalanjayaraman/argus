"""Meta Model API adapter (live).

Boundary (Argus_Agentic_Architecture §5): media models return OBSERVATIONS
only — never verdicts, tolerances, citations or evidence. Rule verdicts are
decided by coordinator.py from these observations.

API: Meta Model API, Responses API at https://api.meta.ai/v1
(POST /responses, Bearer META_API_KEY). Video clips go through the Files
API (POST /files, purpose=user_data) and are referenced by file_id; by
default a video segment is screened from its keyframe (media.model_still)
and only motion rules (8.2-8.4) get the clip.
Models (verified live 2026-11-03 via GET /v1/models):
  Tier 1 screen:  muse-spark-1.3   (META_SCREEN_MODEL)
  Tier 2 review:  muse-wonder-1.0  (META_REVIEW_MODEL)
  Segmentation:   sam-3.1          (META_SAM_MODEL) — one concept per
                  request; output parsed with meta_sam_parser into boxes,
                  one-bit masks (as SVG paths) and confidences.
"""
from __future__ import annotations
import asyncio
import base64
import concurrent.futures
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid

import media

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


_MOTION_CODES = {"8.2", "8.3", "8.4"}  # need the clip, not a still


def _media_content(path: str, source: str, timeout_s: float, rule: dict | None = None) -> dict:
    """Model input for one evidence item: a downscaled still (photo, or the
    keyframe of a video segment), or the clip itself for motion rules."""
    code = (rule or {}).get("ruleId") or ""
    if source == "video" and (code in _MOTION_CODES or os.environ.get("VIDEO_SCREEN_MODE") == "clip"):
        return {"type": "input_file", "file_id": _upload_file_cached(path, timeout_s)}
    still = media.model_still(path, source)
    mime = "image/png" if still.lower().endswith(".png") else "image/jpeg"
    with open(still, "rb") as fh:
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
    if rule.get("orderContext"):
        prompt += (" Compare visible markings and configuration against this customer order "
                   f"document (text extracted from the uploaded file): \"\"\"{rule['orderContext'][:3000]}\"\"\" "
                   "Report a mismatch only when the evidence and the order both show the value.")
    try:
        text = _call_model(model, [
            {"type": "input_text", "text": prompt},
            _media_content(evidence_path, source, timeout_s, rule),
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


# --- SAM 3.1 segmentation -------------------------------------------------

SAM_MIN_CONFIDENCE = float(os.environ.get("SAM_MIN_CONFIDENCE", "0.5"))
SAM_CONCURRENCY = int(os.environ.get("SAM_CONCURRENCY", "6"))
_MAX_PATH_CHARS = 20000
_SAM_CACHE: dict[str, dict] = {}
_SAM_LOCK = threading.Lock()


def _sam_stream_events(still: str, concept: str, timeout_s: float) -> list[dict]:
    """One SAM 3.1 concept request on a still; returns the raw stream events."""
    with open(still, "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode()
    mime = "image/png" if still.lower().endswith(".png") else "image/jpeg"
    payload = {"model": SAM_MODEL, "stream": True,
               "metadata": {"include_confidence": "true", "mask_encoding": "one_bit"},
               "input": [{"type": "message", "role": "user", "content": [
                   {"type": "input_text", "text": concept},
                   {"type": "input_image", "image_url": f"data:{mime};base64,{encoded}"}]}]}
    req = urllib.request.Request(API_BASE + "/responses", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}",
                                          "Content-Type": "application/json"}, method="POST")
    events: list[dict] = []
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:") or line[5:].strip() in ("", "[DONE]"):
                continue
            try:
                events.append(json.loads(line[5:]))
            except json.JSONDecodeError:
                continue
    return events


def parse_sam_events(events: list[dict], min_confidence: float = SAM_MIN_CONFIDENCE) -> dict:
    """SAM stream events -> {objects:[{objectId, box, confidence, mask}]}.
    Parsed with Meta's meta_sam_parser; masks become SVG paths in the
    mask's own bounds (translate by mask.bounds.left/top to draw)."""
    import meta_sam_parser as msp

    async def source():
        for e in events:
            yield e

    async def run():
        return await msp.parse_responses_stream(source(), msp.image_segmentation_format()).final_result()

    result = asyncio.run(run())
    objects: dict[int, dict] = {}
    for rec in result.records:
        if rec.kind == "box":
            objects.setdefault(rec.object_id, {"objectId": rec.object_id})
            objects[rec.object_id]["box"] = {"left": rec.left, "top": rec.top, "right": rec.right, "bottom": rec.bottom}
            objects[rec.object_id]["confidence"] = rec.confidence
        elif rec.kind == "mask":
            obj = objects.setdefault(rec.object_id, {"objectId": rec.object_id})
            try:
                path = msp.decode_mask_to_svg_path(rec.mask)
            except Exception:
                path = ""
            b = rec.bounds
            obj["mask"] = {"bounds": {"left": b.left, "top": b.top, "right": b.right, "bottom": b.bottom},
                           "encoding": str(rec.mask.encoding), "svgPath": path if len(path) <= _MAX_PATH_CHARS else ""}
            if obj.get("confidence") is None:
                obj["confidence"] = rec.confidence
    kept = [o for o in objects.values() if o.get("box") and (o.get("confidence") is None or o["confidence"] >= min_confidence)]
    return {"objects": kept, "outcome": getattr(result.outcome, "status", str(result.outcome)),
            "diagnostics": len(result.diagnostics)}


def segment_concept(evidence_path: str, source: str, concept: str) -> dict:
    """SAM 3.1 on one concept, cached by (media content, concept)."""
    still = media.model_still(evidence_path, source)
    key = hashlib.sha256(f"{media.sha256_file(still)}|{concept}|{SAM_MODEL}".encode()).hexdigest()
    cache_file = os.path.join(media.CACHE_DIR, f"sam-{key}.json")
    with _SAM_LOCK:
        if key in _SAM_CACHE:
            return _SAM_CACHE[key]
    if os.path.exists(cache_file):
        result = json.loads(open(cache_file).read())
    else:
        timeout_s = float(os.environ.get("SAM_TIMEOUT_MS", "240000")) / 1000.0
        started = time.time()
        result = parse_sam_events(_sam_stream_events(still, concept, timeout_s))
        dims = media.dimensions(still)
        result.update({"concept": concept, "model": SAM_MODEL, "seconds": round(time.time() - started, 1),
                       "width": dims[0] if dims else None, "height": dims[1] if dims else None})
        os.makedirs(media.CACHE_DIR, exist_ok=True)
        with open(cache_file, "w") as fh:
            fh.write(json.dumps(result))
    with _SAM_LOCK:
        _SAM_CACHE[key] = result
    return result


def detect_components(evidence_path: str, source: str, components: list[dict]) -> list[dict]:
    """SAM 3.1 component detection: one concept request per component, run
    in parallel (SAM_CONCURRENCY). Returns detected components with their
    boxes, masks and confidences: [{id, prompt, boxes, objects, width, height}].
    A failed concept request is reported with `error`, never as detected."""
    if not _configured() or not evidence_path or not os.path.exists(evidence_path):
        return []

    def one(comp: dict) -> dict:
        try:
            seg = segment_concept(evidence_path, source, comp["samPrompt"])
            return {"id": comp["id"], "prompt": comp["samPrompt"], "boxes": len(seg["objects"]), "objects": seg["objects"],
                    "width": seg.get("width"), "height": seg.get("height"), "seconds": seg.get("seconds")}
        except Exception as exc:
            return {"id": comp["id"], "prompt": comp["samPrompt"], "boxes": 0, "objects": [], "error": str(exc)[:200]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, SAM_CONCURRENCY)) as pool:
        results = list(pool.map(one, components))
    return results


def screen_visual(evidence_path: str, rule: dict, source: str = "image") -> dict:
    """Tier 1 (Muse Spark): screen one segment/photo against one pinned rule."""
    return _visual(SCREEN_MODEL, evidence_path, rule, source)


def review_visual(evidence_path: str, rule: dict, screen: dict | None = None, source: str = "image") -> dict:
    """Tier 2 (Muse Wonder): deeper review of flagged/high-stakes items.
    An additional observation, never a replacement verdict."""
    if isinstance(screen, str):  # tolerate the legacy positional call
        source, screen = screen, None
    return _visual(REVIEW_MODEL, evidence_path, rule, source)


# --- SAM 3.1 video tracking (display-only annotations) ----------------------

def parse_sam_video_events(events: list[dict], min_confidence: float = SAM_MIN_CONFIDENCE) -> dict:
    """SAM video stream events -> {objects:[{objectId, frames:[[frame, left, top, right, bottom, confidence]]}]}.
    Boxes only: per-frame masks are not needed to draw a tracked label."""
    import meta_sam_parser as msp

    async def source():
        for e in events:
            yield e

    async def run():
        return await msp.parse_responses_stream(source(), msp.video_segmentation_format()).final_result()

    result = asyncio.run(run())
    objects: dict[str, list] = {}
    for rec in result.records:
        if rec.kind != "box":
            continue
        conf = rec.confidence if rec.confidence is not None else 1.0
        if conf < min_confidence:
            continue
        objects.setdefault(str(rec.object_id), []).append([rec.frame.frame_index, rec.left, rec.top, rec.right, rec.bottom, round(conf, 3)])
    return {"objects": [{"objectId": oid, "frames": sorted(fr)} for oid, fr in objects.items()],
            "outcome": getattr(result.outcome, "status", str(result.outcome))}


def _sam_video_events(file_id: str, concept: str, timeout_s: float) -> list[dict]:
    payload = {"model": SAM_MODEL, "stream": True,
               "metadata": {"include_confidence": "true", "mask_encoding": "one_bit"},
               "input": [{"type": "message", "role": "user", "content": [
                   {"type": "input_text", "text": concept}, {"type": "input_video", "file_id": file_id}]}]}
    req = urllib.request.Request(API_BASE + "/responses", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}",
                                          "Content-Type": "application/json"}, method="POST")
    events: list[dict] = []
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:") or line[5:].strip() in ("", "[DONE]"):
                continue
            try:
                events.append(json.loads(line[5:]))
            except json.JSONDecodeError:
                continue
    return events


def track_video(video_path: str, components: list[dict]) -> dict:
    """Track each component through a video with SAM 3.1 (one concept per
    request, in parallel) on a low-fps proxy; cached by (proxy, concept).
    Returns {fps, width, height, duration, model, components:[{id, prompt, objects, seconds, error?}]}."""
    if not _configured():
        return {"status": "unavailable", "reason": "META_API_KEY not set or META_ADAPTER_LIVE!=1", "components": []}
    proxy = media.analysis_proxy(video_path)
    timeout_s = float(os.environ.get("SAM_VIDEO_TIMEOUT_MS", "900000")) / 1000.0
    proxy_sha = media.sha256_file(proxy["path"])
    file_id: dict[str, str] = {}

    def one(comp: dict) -> dict:
        key = hashlib.sha256(f"{proxy_sha}|{comp['samPrompt']}|{SAM_MODEL}|video".encode()).hexdigest()
        cache_file = os.path.join(media.CACHE_DIR, f"samvid-{key}.json")
        try:
            if os.path.exists(cache_file):
                parsed = json.loads(open(cache_file).read())
            else:
                with _SAM_LOCK:
                    if "id" not in file_id:
                        file_id["id"] = _upload_file(proxy["path"], timeout_s)
                started = time.time()
                parsed = parse_sam_video_events(_sam_video_events(file_id["id"], comp["samPrompt"], timeout_s))
                parsed["seconds"] = round(time.time() - started, 1)
                with open(cache_file, "w") as fh:
                    fh.write(json.dumps(parsed))
            return {"id": comp["id"], "prompt": comp["samPrompt"], "objects": parsed["objects"], "seconds": parsed.get("seconds")}
        except Exception as exc:
            return {"id": comp["id"], "prompt": comp["samPrompt"], "objects": [], "error": str(exc)[:200]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, SAM_CONCURRENCY)) as pool:
        tracked = list(pool.map(one, components))
    return {"status": "ready", "fps": proxy["fps"], "width": proxy["width"], "height": proxy["height"],
            "duration": proxy["duration"], "model": SAM_MODEL, "components": tracked}
