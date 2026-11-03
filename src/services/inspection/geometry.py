"""Geometry tool: register a laser scan chunk against the CAD reference point cloud.

CAD reference: generated from the given CAD by cad_reference.py
(sampled surface point cloud, mm, cached under src/reference-data/), never from
the Simulator. The Simulator's valve_CAD_reference_full_surface.ply remains
a test fixture only.
Method: voxel downsample -> FPFH global registration (RANSAC) when far apart,
then point-to-point ICP. Reports RMS / mean / 95th-percentile point-to-plane deviation, ICP fitness
and CAD surface coverage. No verdict: the rule gate in coordinator.py
decides, using geometry_gate() and the scan rules' approved thresholds.
"""
from __future__ import annotations
import os
import numpy as np
import open3d as o3d

def _default_reference() -> str:
    """Argus generates its own CAD reference cloud from the given CAD
    (cad_reference.py). CAD_REFERENCE_PLY may point at a pre-generated file;
    otherwise the generated cache for the default pack is used, and it is
    generated on first use if missing."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    cached = os.path.join(root, "src/reference-data", "cvs6000d-48-demo", "cad", "cad_reference.ply")
    if not os.path.exists(cached):
        try:
            import cad_reference
            return cad_reference.reference_for_model("CVS6000_VALVE")["referencePly"]
        except Exception:
            return cached
    return cached


CAD_REFERENCE_PLY = os.environ.get("CAD_REFERENCE_PLY", "") or _default_reference()
VOXEL = float(os.environ.get("GEO_VOXEL_MM", "5.0"))
MAX_CORR = float(os.environ.get("GEO_MAX_CORR_MM", "20.0"))


def load_cloud(path: str, voxel: float = VOXEL):
    pcd = o3d.io.read_point_cloud(path)
    if voxel and len(pcd.points) > 0:
        pcd = pcd.voxel_down_sample(voxel)
    pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=voxel * 2 if voxel else 10, max_nn=30))
    return pcd


def _fpfh(pcd, voxel):
    return o3d.pipelines.registration.compute_fpfh_feature(
        pcd, o3d.geometry.KDTreeSearchParamHybrid(radius=voxel * 5 if voxel else 25, max_nn=100))


def register(scan_path: str, cad_path: str | None = None, voxel: float = VOXEL) -> dict:
    if not os.path.exists(scan_path):
        return {"status": "insufficient", "reason": f"scan not found: {scan_path}"}
    return _register_cloud(load_cloud(scan_path, voxel), cad_path, voxel)


def register_merged(scan_paths: list[str], cad_path: str | None = None, voxel: float = VOXEL) -> dict:
    """Register the merged scan (all chunks of a session) against the CAD
    reference. Coverage is only meaningful on the merged cloud: one chunk
    is one scanner sweep and sees only a slice of the surface."""
    merged = o3d.geometry.PointCloud()
    loaded = 0
    for path in scan_paths:
        if not path or not os.path.exists(path):
            continue
        merged += o3d.io.read_point_cloud(path)
        loaded += 1
    if loaded == 0:
        return {"status": "insufficient", "reason": "no readable scan chunks"}
    if voxel and len(merged.points) > 0:
        merged = merged.voxel_down_sample(voxel)
    merged.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=voxel * 2 if voxel else 10, max_nn=30))
    result = _register_cloud(merged, cad_path, voxel)
    result["mergedChunks"] = loaded
    return result


def _register_cloud(scan, cad_path: str | None = None, voxel: float = VOXEL) -> dict:
    cad_path = cad_path or CAD_REFERENCE_PLY
    if not cad_path or not os.path.exists(cad_path):
        return {"status": "insufficient", "reason": "CAD reference point cloud not configured (CAD_REFERENCE_PLY)"}
    cad = load_cloud(cad_path, voxel)
    if len(scan.points) < 100 or len(cad.points) < 100:
        return {"status": "insufficient", "reason": "too few points after downsampling"}

    # Prepared scan and CAD share the generated frame, so identity ICP is tried
    # first; FPFH/RANSAC global alignment is only a fallback for a moved frame.
    def _icp(init):
        return o3d.pipelines.registration.registration_icp(
            scan, cad, MAX_CORR, init,
            o3d.pipelines.registration.TransformationEstimationPointToPoint(),
            o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=50))
    icp = _icp(np.eye(4))
    if icp.fitness < 0.5:
        try:
            ransac = o3d.pipelines.registration.registration_ransac_based_on_feature_matching(
                scan, cad, _fpfh(scan, voxel), _fpfh(cad, voxel), True, MAX_CORR * 2,
                o3d.pipelines.registration.TransformationEstimationPointToPoint(False), 3,
                [o3d.pipelines.registration.CorrespondenceCheckerBasedOnEdgeLength(0.9),
                 o3d.pipelines.registration.CorrespondenceCheckerBasedOnDistance(MAX_CORR * 2)],
                o3d.pipelines.registration.RANSACConvergenceCriteria(100000, 0.999))
            alt = _icp(ransac.transformation)
            if alt.fitness > icp.fitness:
                icp = alt
        except Exception:
            pass

    aligned = o3d.geometry.PointCloud(scan)
    aligned.transform(icp.transformation)
    cad_tree = o3d.geometry.KDTreeFlann(cad)
    # Deviation is point-to-plane: the signed distance along the CAD surface
    # normal. Unsigned nearest-point distance would mostly measure the CAD
    # reference's own point spacing, not deviation from the surface.
    cad_pts = np.asarray(cad.points)
    cad_normals = np.asarray(cad.normals)
    signed = []
    for p in np.asarray(aligned.points):
        k, idx, d2 = cad_tree.search_knn_vector_3d(p, 1)
        if k:
            signed.append(float(np.dot(p - cad_pts[idx[0]], cad_normals[idx[0]])))
    signed = np.array(signed) if signed else np.array([0.0])
    # Coverage is asked of the CAD surface: a CAD point is covered when the
    # scan comes within MAX_CORR of it. (Marking each scan point's nearest
    # CAD point instead undercounts wherever scan points cluster.)
    cad_to_scan = np.asarray(cad.compute_point_cloud_distance(aligned)) if len(aligned.points) else np.array([1e9])
    covered = cad_to_scan <= MAX_CORR
    dists = np.abs(signed)
    rmse = float(np.sqrt(np.mean(signed ** 2)))
    return {
        "status": "valid" if icp.fitness > 0.1 else "insufficient",
        "rmseMm": round(rmse, 3),
        "fitness": round(float(icp.fitness), 4),
        "surfaceCoverageFraction": round(float(covered.mean()), 4),
        "meanDeviationMm": round(float(dists.mean()), 3),
        "p95DeviationMm": round(float(np.percentile(dists, 95)), 3),
        "rmsDeviationMm": round(rmse, 3),
        "scanPoints": int(len(scan.points)),
        "cadPoints": int(len(cad.points)),
        "transform": icp.transformation.tolist(),
        "frameSource": "icp_cad_reference",
    }
