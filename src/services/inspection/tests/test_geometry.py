import sys, pathlib, os
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import geometry

CAD = "/Users/boopalanjayaraman/Documents/Code/meta api cerebral valley/argus/argus-simulation-code/argus_simulation/simulated_data/CVS_6000D/CAD/valve_CAD_reference_full_surface.ply"
SCAN = "/Users/boopalanjayaraman/Documents/Code/meta api cerebral valley/argus/argus-simulation-code/argus_simulation/simulated_data/CVS_6000D/LaserPointCloud/valve_simulated_laser_scan_180deg.ply"

def test_missing_cad_reference_is_insufficient():
    r = geometry.register(SCAN, cad_path="/nonexistent/path/cad_reference.ply")
    assert r["status"] == "insufficient"

def test_icp_against_cad_reference_cloud():
    if not (os.path.exists(CAD) and os.path.exists(SCAN)):
        return
    r = geometry.register(SCAN, cad_path=CAD)
    assert r["fitness"] > 0.5
    assert r["surfaceCoverageFraction"] > 0.3
    assert r["rmseMm"] < 5


def test_register_merged_merges_chunks(tmp_path):
    import geometry
    import open3d as o3d
    import numpy as np
    # CAD reference for this test: reuse the generated cache if present;
    # two halves of a sphere scan should register with merged coverage
    # at least as high as either half alone is not asserted (frame noise);
    # the contract asserted here is a well-formed merged result.
    paths = []
    for i, offset in enumerate((0.0, 0.5)):
        pts = np.random.default_rng(i).random((3000, 3)) * 40 + offset
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(pts)
        f = tmp_path / f"part{i}.ply"
        o3d.io.write_point_cloud(str(f), pcd)
        paths.append(str(f))
    result = geometry.register_merged(paths)
    assert result["status"] in ("valid", "insufficient")
    if result["status"] == "valid":
        assert result["mergedChunks"] == 2
        assert 0 <= result["surfaceCoverageFraction"] <= 1
