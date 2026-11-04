import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import dossier_pdf


def test_dossier_pdf_renders_all_sections():
    d = {
        "inspection": {"id": "insp-1", "name": "Run <A> & B", "outcome": "FAIL", "lifecycleStatus": "COMPLETED", "partial": False,
                       "createdAt": "2026-11-04T00:00:00Z", "closedAt": "2026-11-04T00:10:00Z"},
        "baseline": {"cadName": "Scenario 1", "modelId": "CVS6000_VALVE", "cadRevision": "demo-1", "cadSha256": "e692", "family": "Valve",
                     "type": "swing_check", "endConnection": "flanged", "snapshotId": "ref-insp-1-r1", "snapshotSha256": "abc", "libraryRevision": "50c8",
                     "cascade": {"library": 161, "valveType": 153, "customerSpec": 70, "orderRules": 6},
                     "order": {"orderNumber": "WO-1", "name": "wo.pdf", "sha256": "dead"}},
        "summary": {"applicable": 3, "pass": 1, "warning": 1, "fail": 1, "insufficient": 0, "notInspected": 0},
        "geometry": {"status": "valid", "fitness": 1, "coverage": 0.946, "rmsDeviationMm": 2.0, "p95DeviationMm": 4.1, "meanDeviationMm": 1.5, "chunks": 16},
        "findings": [{"ruleId": "4.7", "title": "Face protection", "status": "FAIL", "quote": "Protector fitted", "citation": "ASME · § Flanged Ends · rule 4.7",
                      "reason": "no protector", "evidence": ["1.png"]},
                     {"ruleId": "2.7", "title": "Plate", "status": "PASS", "quote": "Not loose", "citation": "c", "reason": "ok", "evidence": []},
                     {"ruleId": "WO-R02", "title": "Sealing face", "status": "WARNING", "quote": "q", "citation": "c", "reason": "line", "evidence": []}],
        "notEvaluated": [{"ruleId": "9.1", "title": "Shell test", "citation": "c"}],
        "incomplete": [{"kind": "visual", "evidenceId": "ev-photo-0006", "reason": "Not finished"}],
        "evidence": [{"mediaType": "photo", "filename": "1.png", "sourceId": "camera-photos-01", "size": 10, "sha256": "f" * 64, "processingStatus": "done"}],
        "generatedAt": "2026-11-04T00:10:00Z", "disclaimer": "Human review required.",
    }
    pdf = dossier_pdf.build_pdf(d)
    assert pdf.startswith(b"%PDF") and len(pdf) > 3000
    import pypdf, io
    text = "".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages)
    for needle in ["Argus inspection dossier", "Run <A> & B", "FAIL", "Face protection", "Laser scan vs CAD", "Evidence register", "Incomplete analysis", "WO-1"]:
        assert needle in text, needle
