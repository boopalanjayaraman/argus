"""CAD reference point-cloud generator.

Customer/User supplies only the CAD (selected by model_id from
src/cad_models.json). Argus derives the comparison reference itself:
uniformly sample the CAD mesh surface into a point cloud (mm), cache it
under src/reference-data/<pack>/cad/, and record the source CAD hash so the
reference is regenerated only when the CAD revision changes.

This is derived design intent, NOT evidence: it is generated from the given
CAD, labelled derived, and never presented as the original STEP/STL or as
an observed scan.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path

import open3d as o3d

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_POINTS = int(os.environ.get("CAD_REFERENCE_POINTS", "680000"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate_reference_cloud(cad_file: str, out_ply: str, num_points: int = DEFAULT_POINTS, force: bool = False) -> dict:
    """Sample the CAD mesh surface into a reference PLY. Cached by CAD hash."""
    cad = Path(cad_file)
    out = Path(out_ply)
    meta_path = out.with_suffix(".json")
    cad_hash = _sha256(cad)
    if out.exists() and meta_path.exists() and not force:
        meta = json.loads(meta_path.read_text())
        if meta.get("sourceCadSha256") == cad_hash and meta.get("points") == num_points:
            return {**meta, "cached": True}

    mesh = o3d.io.read_triangle_mesh(str(cad))
    if len(mesh.triangles) == 0:
        raise ValueError(f"CAD file has no triangles (is it a mesh?): {cad_file}")
    sampled = mesh.sample_points_uniformly(number_of_points=num_points)

    out.parent.mkdir(parents=True, exist_ok=True)
    o3d.io.write_point_cloud(str(out), sampled)
    meta = {
        "derived": True,
        "kind": "cad_reference_point_cloud",
        "sourceCad": cad.name,
        "sourceCadSha256": cad_hash,
        "points": int(len(sampled.points)),
        "units": "mm",
        "method": "open3d.sample_points_uniformly",
        "output": out.name,
    }
    meta_path.write_text(json.dumps(meta, indent=1))
    return {**meta, "cached": False}


def reference_for_model(model_id: str, models_file: str | None = None,
                        ref_root: str | None = None, num_points: int = DEFAULT_POINTS) -> dict:
    """Resolve model_id from cad_models.json and return its reference cloud,
    generating it on first use. This is the user-facing path: CAD given
    (by selection), reference cloud produced by Argus."""
    models_path = Path(models_file) if models_file else REPO_ROOT / "src" / "cad_models.json"
    models = json.loads(models_path.read_text())["cad_models"]
    model = next((m for m in models if m["model_id"] == model_id), None)
    if model is None:
        raise ValueError(f"Unknown model_id: {model_id}")
    # Models sharing one CAD (same sha256) share one reference pack and cache.
    pack = model.get("reference_pack") or "cvs6000d-48-demo"
    root = Path(ref_root) if ref_root else REPO_ROOT / "src/reference-data" / pack / "cad"
    cad_file = (models_path.parent / model["cad_file"]).resolve()
    out = root / "cad_reference.ply"
    result = generate_reference_cloud(str(cad_file), str(out), num_points=num_points)
    return {**result, "model_id": model_id, "cadFile": model["cad_file"], "referencePly": str(out)}


if __name__ == "__main__":
    import sys
    model = sys.argv[1] if len(sys.argv) > 1 else "CVS6000_VALVE"
    print(json.dumps(reference_for_model(model), indent=1))
