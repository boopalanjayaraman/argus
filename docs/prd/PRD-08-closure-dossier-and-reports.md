# PRD-08 — Closure, Dossier & Reports (Argus)

Status: Implemented (v2, 03 Nov 2026: End drains / Terminate cancels in-flight analysis; closed sessions immune to late results; dossier cites document · section · rule) · Source: Spec §§4.5–4.6, 8 · Depends on: PRD-05, PRD-06, PRD-07

## Specs

- **End Inspection:** confirm → `FINALIZING` (intake sealed: uploads `409`) → the API answers `202` and drains the session's analysis queue for up to `CLOSE_DRAIN_TIMEOUT_MS` → anything still running is cancelled and listed in the dossier as incomplete analysis → full HTML dossier → `COMPLETED` (outcome may still be `INCONCLUSIVE`). The UI follows FINALIZING → COMPLETED over SSE.
- **Terminate Now:** confirm → seal intake + cancel every queued/running job at once (aborting its HTTP calls) → partial dossier → `TERMINATED`, outcome `INCONCLUSIVE` (verified FAIL retained, never green PASS). Cancelled evidence is marked `cancelled`.
- **Late results never land:** every write path (findings, SAM observations, geometry) checks the session is still open and the job not aborted; a result that returns after closure is discarded.
- Both freeze snapshots/history, reject later uploads (`409 SESSION_CLOSED` — Simulator stops on this), link dossier on Home + Reports. Closed view is read-only with retained playable evidence/timeline.
- Dossier (HTML; PDF optional): header + overall conclusion, lifecycle/timestamps/closure mode, reference baseline (CAD hash, equipment, **rule snapshot ID + sha256 + library revision**, rule-selection cascade, order document + hash), counters over the pinned applicable rules, per-rule quote + **citation `document · section · rule N`** (page for order rules; never an empty page field) + reason + evidence filenames, laser-scan registration metrics, incomplete analysis, rules not evaluable from session evidence, evidence register with sha256 and analysis state, human-review disclaimer. All values HTML-escaped.
- Reports `/reports`: filters All/Pass/Warning/Fail/Inconclusive, search, View/Download; only persisted finalized dossiers; generation failure shows error/retry state.
- Outcome aggregation: verified `FAIL` dominates → else `WARNING` if warnings and no missing required checks → else `INCONCLUSIVE` if required checks uninspected/insufficient → `PASS` only when all required applicable rules pass.

Out of scope: PDF export, QMS/ERP, approval workflows.

## Technical Specs

- **Pattern:** two-phase finalize — (1) seal intake atomically (lifecycle flip makes PRD-04 return `409`), (2) async dossier render from immutable snapshot into GCS + `dossiers` record; render is idempotent and regenerable from frozen data without touching originals.
- **Timeout pattern:** `CLOSE_DRAIN_TIMEOUT_MS` (default 120000) bounds End-Inspection draining via `AnalysisQueue.drain`; on expiry `AnalysisQueue.cancel` aborts the rest, recorded incomplete in the dossier, not silently dropped. Terminate bypasses draining. A restart during `FINALIZING` resumes finalization.
- **API:** `POST .../close`, `POST .../terminate`, `GET .../dossier`, `GET /api/v1/reports`, `GET /api/v1/instruction-sets` (Rules page, if not already in PRD-02).
- **Configuration:** `DOSSIER_TEMPLATE_VERSION` stamped into each dossier for reproducibility.

## Acceptance

- [x] Full + partial (mid-stream terminate) dossiers generate, persist, and reopen read-only.
- [x] Terminate during in-flight analysis writes no finding afterwards; End waits for in-flight analysis.
- [ ] Reports filters/View/Download work; post-close Simulator send stops with Not sent rows.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §§4.5–4.6,8,10 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §§6–8 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §7
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) closed-session/Dossier/Reports + `bundle.css`; replicate values, don't ship markup.

## Test Plan (write before implementation — tests fail first)

- Unit: outcome aggregation matrix — FAIL dominates; WARNING+missing→`INCONCLUSIVE`; PASS only all-required-pass; terminated→`INCONCLUSIVE` with FAIL retained.
- Contract: `close` drains or records incomplete on `CLOSE_DRAIN_TIMEOUT_MS`; `terminate` cancels promptly; post-seal upload `409`; dossier render idempotent from snapshot.
- UI/E2E: full dossier (End) + partial dossier (mid-stream Terminate); Reports filters/View/Download only persisted dossiers; closed view read-only.
- Negative: dossier generation failure → error/retry state, session stays truthfully `FINALIZING`/error, never fake `COMPLETED`.

## Verification (after implementation)

- [ ] Run this PRD's full test list + Acceptance above.
- [ ] Playwright both walkthroughs (Spec §12 + terminate variant) with Simulator. No test red/skipped.

## Review gate

v2 implemented on the user's go-ahead of 03 Nov 2026 (issues #6, #9). Edit this file to change scope.
