# PRD-03 — Home & Session Creation (Argus)

Status: Implemented (v2, 03 Nov 2026: pinned rule snapshot on create; order document upload parsed into order rules) · Source: Spec §3 · Tech Stack §4 · Depends on: PRD-01, PRD-02

## Specs

- Home `/`: title “Autonomous Industrial Inspection”, left **Inspections** list (search by name/ID; filter tabs All/Active/Completed/Terminated with live counts; columns Inspection, Started, Session, Outcome, Findings mini-distribution; newest first; row → live or read-only session), right **Start inspection** panel.
- Start: required **Inspection name** (Start disabled until valid), **CAD model selector** populated from `cad_models.json` (`display_name` shown, `model_id` submitted), optional **customer specification / work order** upload (PDF, DOCX, XLSX). The upload is the demo path for the work order (`src/reference-data/cvs6000d-48-demo/customer-documents/Argus_CVS6000D_48in_Work_Order.pdf`); without one, no order rules apply and the session says “None uploaded”. The panel shows the chosen file and a remove control; the Rules summary says whether order rules will be added.
- **Order rules:** the uploaded document's text is extracted (pypdf for PDF, OOXML for DOCX/XLSX) and only rules the document prints with an ID (`WO-R01` … in a rule table, or `ID: text` lines) become session rules, quoted verbatim with page, evidence and severity text. Narrative text never becomes a criterion. A printed severity cap (e.g. `WARNING / QC review`) is kept as `maxSeverity`. Rules whose evidence is a test record are `REFERENCE_ONLY`.
- On create: pin the **reference snapshot** (CAD revision/hash, equipment family/type/ends, library revision, selected rules incl. order rules, order document hash), then navigate to `/inspections/:id` in `WAITING`. History survives restart (Mongo).
- While still `WAITING`, the Applicable Rules tab may attach an order document; this pins snapshot revision 2. Once evidence arrives the snapshot is frozen (`409 SNAPSHOT_FROZEN`).

Out of scope: evidence upload UI (PRD-05 shell; ingestion in PRD-04), closure (PRD-08), parsing criteria out of narrative text.

## Technical Specs

- **API:** `POST /api/v1/inspections` (JSON, or multipart with `name`, `model_id`, `file`), `POST /api/v1/inspections/:id/order-document` (multipart, WAITING only), `GET /api/v1/inspections` (search/filter/counts computed server-side). Lifecycle and outcome stored as separate fields.
- **Pattern:** snapshot-on-create — `referenceSnapshots` record `ref-<sessionId>-r<n>` with sha256 of its rules; the session stores `referenceSnapshotId`. Library edits never mutate existing sessions. Sessions created before snapshots existed get one on first access, marked `legacy`.
- **Document extraction:** API stores the bytes (`documents` collection, GCS when configured), then calls the inspection service `POST /documents/extract` with the file URL; the response `{pages, orderNumber, rules[], context}` is stored with the document. Extraction failure keeps the document, adds no rules and says so.
- **Configuration:** `MAX_ORDER_UPLOAD_MB` (default 25) → `413`; other extensions → `415`.

## Acceptance

- [x] Create with name only and with an order upload; both land on Waiting with the correct CAD; the upload adds WO-R01…R06 (WO-R07 reference-only) for the demo work order.
- [x] Library change after create does not change the session's rules.
- [ ] Filters/counts/search reflect persisted sessions after restart (manual).

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §3 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §4 · Agentic: session pinning §4
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) Home artboard + `bundle.css`; replicate values, don't ship markup.

## Test Plan

- API (Vitest, mock orchestrator): multipart create with order → order rules in snapshot, `cascade.orderRules`, order file downloadable; `.txt` → `415`; attach while WAITING → `r2`; after evidence → `409 SNAPSHOT_FROZEN`; injected library rule appears in new sessions only.
- Python (pytest): the demo work order PDF yields exactly WO-R01…WO-R07 with verbatim quotes, including WO-R07 across a page break; severity caps and modalities parsed.

## Verification

- [x] API and Python suites green.
- [ ] Playwright: create (with/without upload) → Waiting with selected CAD.

## Review gate

Implemented on the user's go-ahead of 03 Nov 2026 (issues #4, #12, #23). Edit this file to change scope.
