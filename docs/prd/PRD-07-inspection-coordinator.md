# PRD-07 — Inspection Coordinator: AI & Geometry (Argus)

Status: Awaiting review · Source: Spec §9 · Agentic Architecture §§2,5–6 · Depends on: PRD-04, PRD-06

## Specs

- Exactly **one bounded Inspection Coordinator** (Python FastAPI) reacts to evidence events; tools: Muse Spark 1.3 visual observations on actual media + pinned rule context, SAM 3.1 segmentation when localization helps, Open3D/CAD geometry (registration, deviation, coverage, uncertainty), deterministic Evidence Correlator + Rule & Quality Gate. No agent personas beyond the coordinator; tools are not agents.
- Coordinator cannot: invent tolerances/quotes/CAD anchors, read Simulator ground truth, rewrite bytes, close sessions, or grant release. Findings are versioned (never silently overwritten) with evidence IDs, model/tool versions, call IDs, limitations.
- Gates: photo hairline → `WARNING`/review only; unused flange bolt holes ≠ missing bonnet fasteners; mm claims require known units + validated registration + approved tolerance else `INSUFFICIENT_EVIDENCE`; “no crack seen” scoped to inspected coverage; unmapped feature → `cadAnchor: null`.

Out of scope: acoustic/NDT/robotics, model training, dossier rendering (PRD-08).

## Technical Specs

- **Pattern:** bounded async job queue (local queue dev; Cloud Tasks deployed) decouples `202` from inference; jobs leased + idempotent per `evidenceId` so retries never double-count. Job failure leaves rule `NOT_INSPECTED`/`INSUFFICIENT_EVIDENCE` — never PASS.
- **Retry pattern:** Meta calls with timeout + bounded retries (exponential backoff, jitter); every attempt logged with model version + error. SAM output parsed via Meta parser; SAM never issues verdicts.
- **Typed contracts:** observation schemas per Agentic Architecture §6 (`possible_surface_line`, geometry `registration{rmseMm, surfaceCoverageFraction}`, etc.) validated with Pydantic; model free-text never becomes a citation or threshold.
- **Configuration (env):** `META_MODEL=muse-spark-1.3`, `SAM_MODEL=sam-3-1`, `META_TIMEOUT_MS`, `META_MAX_RETRIES`, `GEO_REGISTRATION_MAX_RMSE_MM`; non-contributor/private inference where available.

## Acceptance

- [ ] One real finding traces media → observation → rule gate → pinned quote in UI.
- [ ] Model timeout/geometry-without-registration demonstrably yields `INSUFFICIENT_EVIDENCE`, not PASS.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §9 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §§2,7,9 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §§2,5–6
- UX: findings feed in [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html); replicate states, don't ship markup. Models: Meta docs linked in Tech Stack §2.

## Test Plan (write before implementation — tests fail first)

- Unit (pytest): Pydantic observation schemas reject free-text citation/threshold; correlator keeps contradictory observations; gate: hairline→`WARNING`, unregistered scan→`INSUFFICIENT_EVIDENCE`, unused flange holes ≠ missing fastener.
- Contract: job per `evidenceId` idempotent (re-run = one finding revision chain); Meta timeout/retry-exhausted → `NOT_INSPECTED/INSUFFICIENT_EVIDENCE`, never PASS; versions/call IDs persisted.
- Integration (mocked Meta/SAM): real photo fixture → observation → finding with pinned quote + evidence IDs; SAM mask never yields verdict.
- Negative: occluded region, missing units, `cadAnchor` unmapped → no PASS, no CAD marker.

## Verification (after implementation)

- [ ] Run this PRD's full test list (pytest + Vitest) + Acceptance above; one live Meta smoke test recorded.
- [ ] Manual: trace one finding media→observation→gate→quote in UI. No test red/skipped.

## Review gate

Reply `go PRD-07` to implement, or edit this file first.
