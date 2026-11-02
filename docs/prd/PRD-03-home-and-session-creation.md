# PRD-03 — Home & Session Creation (Argus)

Status: Awaiting review · Source: Spec §3 · Tech Stack §4 · Depends on: PRD-01, PRD-02

## Specs

- Home `/`: title “Autonomous Industrial Inspection”, left **Inspections** list (search by name/ID; filter tabs All/Active/Completed/Terminated with live counts; columns Inspection, Started, Session, Outcome, Findings mini-distribution; newest first; row → live or read-only session), right **Start inspection** panel.
- Start: required **Inspection name** (Start disabled until valid), **CAD model selector** populated from `cad_models.json` (`display_name` shown, `model_id` submitted — CAD is selected from the provisioned list, never uploaded in this UI), optional customer spec/work-order upload (PDF/DOCX/XLSX; not required — pinned demo work order disclosed when used), Rules summary derived from selected `model_id` + effective document. Upload never fabricates acceptance criteria.
- On create: pin baseline (CAD revision/hash, rule snapshot, source docs), navigate to `/inspections/:id` in `WAITING`. History survives restart (Mongo).

Out of scope: evidence upload UI (PRD-05 shell; ingestion in PRD-04), closure (PRD-08).

## Technical Specs

- **API:** `POST /api/v1/inspections` (multipart when order file present), `GET /api/v1/inspections` (search/filter/counts computed server-side). Lifecycle and outcome stored as separate fields from day one.
- **Pattern:** snapshot-on-create — session stores immutable `referenceSnapshotId` including selected `model_id` + CAD `revision`/`sha256`; later library edits never mutate existing sessions. Session ID format `insp-...`, copyable in session header. Server resolves `model_id` against `cad_models.json`; unknown ID → `400`, client-supplied paths are rejected.
- **Configuration:** `DEMO_WORK_ORDER` path in reference pack; `MAX_ORDER_UPLOAD_MB` limit with `413` on exceed.
- **Validation:** Zod on name/file type; friendly error if reference pack unavailable.

## Acceptance

- [ ] Create with name only and with order upload; both land on Waiting with correct CAD.
- [ ] Filters/counts/search reflect persisted sessions after restart.

## Review gate

Reply `go PRD-03` to implement, or edit this file first.
