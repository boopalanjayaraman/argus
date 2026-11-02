# PRD-08 — Closure, Dossier & Reports (Argus)

Status: Awaiting review · Source: Spec §§4.5–4.6, 8 · Depends on: PRD-05, PRD-06, PRD-07

## Specs

- **End Inspection:** confirm → seal intake → drain accepted analysis within bounded timeout → mark remaining checks incomplete → `FINALIZING` → full HTML dossier → `COMPLETED` (outcome may still be `INCONCLUSIVE`).
- **Terminate Now:** confirm → seal intake + cancel pending work promptly → partial dossier → `TERMINATED`, outcome defaults `INCONCLUSIVE` (verified FAIL retained, never green PASS).
- Both freeze snapshots/history, reject later uploads (`409 SESSION_CLOSED` — Simulator stops on this), link dossier on Home + Reports. Closed view is read-only with retained playable evidence/timeline.
- Dossier (HTML; PDF optional): header + overall conclusion, lifecycle/timestamps/closure mode, pinned CAD/order IDs, rule counters with coherent denominators, per-finding rule ID + exact citation + evidence links + measurements/uncertainty, completeness/coverage, uninspected criteria, human-review disclaimer, frozen checksums + revision history.
- Reports `/reports`: filters All/Pass/Warning/Fail/Inconclusive, search, View/Download; only persisted finalized dossiers; generation failure shows error/retry state.
- Outcome aggregation: verified `FAIL` dominates → else `WARNING` if warnings and no missing required checks → else `INCONCLUSIVE` if required checks uninspected/insufficient → `PASS` only when all required applicable rules pass.

Out of scope: PDF export, QMS/ERP, approval workflows.

## Technical Specs

- **Pattern:** two-phase finalize — (1) seal intake atomically (lifecycle flip makes PRD-04 return `409`), (2) async dossier render from immutable snapshot into GCS + `dossiers` record; render is idempotent and regenerable from frozen data without touching originals.
- **Timeout pattern:** `CLOSE_DRAIN_TIMEOUT_MS` bounds End-Inspection draining; on expiry, unfinished jobs are recorded incomplete (listed in dossier), not silently dropped. Terminate bypasses draining.
- **API:** `POST .../close`, `POST .../terminate`, `GET .../dossier`, `GET /api/v1/reports`, `GET /api/v1/instruction-sets` (Rules page, if not already in PRD-02).
- **Configuration:** `DOSSIER_TEMPLATE_VERSION` stamped into each dossier for reproducibility.

## Acceptance

- [ ] Full + partial (mid-stream terminate) dossiers generate, persist, and reopen read-only.
- [ ] Reports filters/View/Download work; post-close Simulator send stops with Not sent rows.

## Review gate

Reply `go PRD-08` to implement, or edit this file first.
