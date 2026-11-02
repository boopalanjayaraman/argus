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
