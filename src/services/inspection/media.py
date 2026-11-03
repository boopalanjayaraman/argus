"""Model-ready stills derived from evidence (derived artifacts, never evidence).

SAM 3.1 takes one concept per request and Muse calls are priced per input,
so photos are downscaled to a JPEG and each video segment contributes one
keyframe instead of uploading the whole clip. Originals stay untouched;
derived files are cached by source content hash.
"""
from __future__ import annotations
import hashlib
import os
import shutil
import subprocess
import tempfile

MAX_EDGE = int(os.environ.get("MODEL_IMAGE_MAX_EDGE", "1280"))
CACHE_DIR = os.environ.get("MODEL_MEDIA_CACHE", os.path.join(tempfile.gettempdir(), "argus-model-media"))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True, timeout=120)


def model_still(path: str, source: str) -> str:
    """A JPEG (long edge <= MAX_EDGE) for model input: the photo itself,
    or the middle frame of a video segment. Falls back to the original
    photo when ffmpeg is unavailable; a video without ffmpeg raises."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    out = os.path.join(CACHE_DIR, f"{sha256_file(path)}-{MAX_EDGE}.jpg")
    if os.path.exists(out):
        return out
    if not shutil.which("ffmpeg"):
        if source == "video":
            raise RuntimeError("ffmpeg is required to take a keyframe from video")
        return path
    scale = f"scale='if(gt(iw,ih),min({MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_EDGE},ih))'"
    if source == "video":
        duration = _duration(path)
        _ffmpeg(["-ss", f"{max(0.0, duration / 2):.3f}", "-i", path, "-frames:v", "1", "-vf", scale, "-q:v", "3", out])
    else:
        _ffmpeg(["-i", path, "-vf", scale, "-q:v", "3", out])
    return out


def _duration(path: str) -> float:
    try:
        res = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                             capture_output=True, text=True, timeout=30)
        return float(res.stdout.strip() or 0)
    except Exception:
        return 0.0


def dimensions(path: str) -> tuple[int, int] | None:
    try:
        res = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                              "-of", "csv=p=0:s=x", path], capture_output=True, text=True, timeout=30)
        w, h = res.stdout.strip().split("x")[:2]
        return int(w), int(h)
    except Exception:
        return None
