import sys, pathlib, os
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import cad_reference, geometry

SCAN = "/Users/boopalanjayaraman/Documents/Code/meta api cerebral valley/argus/argus-simulation-code/argus_simulation/simulated_data/CVS_6000D/LaserPointCloud/valve_simulated_laser_scan_180deg.ply"

def test_reference_generated_from_given_cad(tmp_path):
    out = tmp_path / "cad_reference.ply"
    repo = pathlib.Path(__file__).resolve().parents[4]
    meta = cad_reference.generate_reference_cloud(str(repo / "src/data/CAD_files/cvs6000_valve.stl"), str(out), num_points=20000)
    assert meta["derived"] is True and meta["units"] == "mm"
    assert meta["points"] == 20000 and out.exists()
    import json as _json
    assert meta["sourceCadSha256"] == _json.loads((repo / "src/cad_models.json").read_text())["cad_models"][0]["sha256"]
    # cached second call
    assert cad_reference.generate_reference_cloud(str(repo / "src/data/CAD_files/cvs6000_valve.stl"), str(out), num_points=20000)["cached"] is True

def test_scan_registers_against_generated_reference():
    if not os.path.exists(SCAN):
        return
    r = geometry.register(SCAN)  # no CAD_REFERENCE_PLY: must use Argus-generated reference
    assert r["fitness"] > 0.5 and r["rmseMm"] < 5, r
