# PRD-06 — Applicable Rules & Documents (Argus)

Status: Awaiting review · Source: Spec §§5–6 · Depends on: PRD-02, PRD-03, PRD-05

## Specs

- Session tabs: active `Live · Applicable Rules N · Documents N`; closed adds `Dossier`. Counts from backend, never hardcoded.
- Applicable Rules: selection cascade with computed totals — (1) rule library, (2) match valve type, (3) match customer specification (pinned demo work order disclosed when no upload). Grouped rule table (rule/section no., name, acceptance condition, modality, state); expand shows pinned source quote/page, CAD feature, rationale, observations, evidence IDs, missing prerequisites. **Why these rules** panel explains inclusions/exclusions. Statuses: `NOT_INSPECTED, ANALYZING, PASS, WARNING, FAIL, INSUFFICIENT_EVIDENCE, NOT_APPLICABLE` (excluded from denominator).
- Documents: filter tabs All/Reports/Specifications/Video/Photographs/Point clouds + search; table filename, provenance/source, type, real byte size, receipt/source time, hash, authorized download, preview. Includes pinned CAD/rules/work order + all evidence + dossier when present; totals reconcile.

Out of scope: live rule evaluation (PRD-07), dossier generation (PRD-08).

## Technical Specs

- **Pattern:** deterministic selector service — library → type/feature filter → order filter; LLM may propose candidates but only deterministic/human-configured mapping binds. Every selection stores a machine-readable reason code + human text.
- **Citation integrity:** citations resolve to the session's pinned snapshot (`sourceSnapshotId`), never the live library — later edits cannot rewrite history.
- **API:** `GET /api/v1/inspections/:id/rules` (cascade + per-rule state), `GET .../documents`, `GET .../evidence` (PRD-04) reused for downloads via signed URLs.
- **Configuration:** none new; selector thresholds are data in `rules.json`, not code constants.

## Acceptance

- [ ] Cascade counts computed from real records; each rule's Why + pinned quote opens correctly.
- [ ] Documents totals equal stored assets (e.g. evidence + references + dossier).

## Review gate

Reply `go PRD-06` to implement, or edit this file first.
