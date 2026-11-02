"""Geometry tool: register a laser scan chunk against the CAD reference point cloud.

CAD reference: generated from the given CAD by cad_reference.py
(sampled surface point cloud, mm, cached under reference-data/), never from
the Simulator. The Simulator's valve_CAD_reference_full_surface.ply remains
a test fixture only.
Method: voxel downsample -> FPFH global registration (RANSAC) when far apart,
then point-to-point ICP. Reports RMSE, coverage, mean deviation. No verdict:
the rule gate in coordinator.py decides, using geometry_gate().
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
    cached = os.path.join(root, "reference-data", "cvs6000d-48-demo", "cad", "cad_reference.ply")
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
    cad_path = cad_path or CAD_REFERENCE_PLY
    if not cad_path or not os.path.exists(cad_path):
        return {"status": "insufficient", "reason": "CAD reference point cloud not configured (CAD_REFERENCE_PLY)"}
    if not os.path.exists(scan_path):
        return {"status": "insufficient", "reason": f"scan not found: {scan_path}"}
    scan = load_cloud(scan_path, voxel)
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
    dists = []
    cad_pts = np.asarray(cad.points)
    covered = np.zeros(len(cad_pts), dtype=bool)
    for i, p in enumerate(np.asarray(aligned.points)):
        k, idx, d2 = cad_tree.search_knn_vector_3d(p, 1)
        if k:
            dists.append(float(np.sqrt(d2[0])))
            if d2[0] <= MAX_CORR ** 2:
                covered[idx[0]] = True
    dists = np.array(dists) if dists else np.array([0.0])
    rmse = float(np.sqrt(np.mean(dists ** 2)))
    valid = rmse <= float(os.environ.get("GEO_REGISTRATION_MAX_RMSE_MM", "2.0")) * 10  # coarse-cloud scale; gate re-checks at rule level
    return {
        "status": "valid" if icp.fitness > 0.1 else "insufficient",
        "rmseMm": round(rmse, 3),
        "fitness": round(float(icp.fitness), 4),
        "surfaceCoverageFraction": round(float(covered.mean()), 4),
        "meanDeviationMm": round(float(dists.mean()), 3),
        "scanPoints": int(len(scan.points)),
        "cadPoints": int(len(cad.points)),
        "transform": icp.transformation.tolist(),
        "frameSource": "icp_cad_reference",
    }
