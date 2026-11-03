# PRD-07 — Inspection Coordinator: AI & Geometry (Argus)

Status: Implemented (v2, 03 Nov 2026: live per-evidence analysis queue; SAM 3.1 masks live; model-cost controls; approved scan rules) · Source: Spec §9 · Agentic Architecture §§2,5–6 · Depends on: PRD-04, PRD-06 · Routing detail: PRD-10

## Specs

- **Orchestrator + independent sub-agents (user-directed, Cycle 3–4):** the Planner/Orchestrator (`src/services/inspection/agents.py`) routes each evidence event to the sub-agent owning its media type (VideoAgent / ImageAgent / PointCloudAgent, each its own HTTP service), runs independent events in parallel and logs every outcome under the session context; ReportAgent aggregates at closure. **The deterministic rule gate (`coordinator.evaluate_rule`) is the only verdict issuer.**
- **Live analysis:** every accepted photo is queued for analysis the moment it is stored; video segments are sampled (one in `VIDEO_ANALYSIS_EVERY`, default 4, plus the last segment at `/complete`; the rest are recorded `sampled_out`); every point-cloud chunk (re)schedules the merged-scan comparison. Findings, SAM observations and coverage stream to the UI while evidence is still arriving (`202` still means queued, not analysed).
- **Pinned rules only:** each analysis request carries the session snapshot's evaluable rules, the equipment family/type, the order document text (when uploaded) and the IDs of rules already decided (video re-screens nothing already decided).
- **Visual path (per photo / sampled video segment):** SAM 3.1 detects which configured components are visible (PRD-10) → deterministic routing picks the rules those components allow → Muse Spark 1.3 screens each routed rule (Tier 1) → Muse Wonder 1.0 reviews flagged/critical items (Tier 2) → the gate decides. Rules needing records beyond the image are skipped, or reported `INSUFFICIENT_EVIDENCE` if critical. With an order document, document-comparison rules are screened against the order text.
- **Geometry path:** all received chunks merged, ICP-registered to the CAD reference cloud of the session's model; reports fitness, CAD-surface coverage, RMS / mean / p95 point-to-plane deviation. Scan rules **GEO-001…003** (approved DEMO_ONLY thresholds: fitness ≥ 0.90 and coverage ≥ 80%; RMS ≤ 3.0 mm; p95 ≤ 6.0 mm) are decided by the gate; below the registration prerequisites they are `INSUFFICIENT_EVIDENCE`, never PASS or FAIL. The merged comparison is coalesced: chunks arriving mid-run cause exactly one more run.
- Gates unchanged: photo hairline → `WARNING`; unused flange bolt holes ≠ missing bonnet fasteners; a rule printing `WARNING` as its severity (order rules) is capped at `WARNING`; model unavailable/timeout never becomes PASS; unmapped feature → `cadAnchor: null`.
- Coordinator cannot: invent tolerances/quotes/CAD anchors, read Simulator ground truth, rewrite bytes, close sessions, or grant release.

Out of scope: acoustic/NDT/robotics, model training, dossier rendering (PRD-08).

## Technical Specs

- **Queue (API, `src/apps/api/src/analysis.ts`):** bounded per kind (`ANALYSIS_CONCURRENCY` visual jobs, 1 geometry job), dedup by job id, coalescing re-run for geometry, drain-with-deadline and cancel (AbortController) for closure (PRD-08). Restart recovery re-queues accepted-but-unanalysed evidence of open sessions.
- **Model-cost controls (issue #10):** photos sent to models as downscaled JPEG (`MODEL_IMAGE_MAX_EDGE`, default 1280 px); a video segment contributes one keyframe (`media.model_still`), only motion rules 8.2–8.4 receive the clip; SAM prompts only components that can route a rule in this session; SAM concept requests run in parallel (`SAM_CONCURRENCY`, default 10) and are cached by (still sha256, concept, model); downloaded evidence cached by URL.
- **Typed contracts:** observations `{kind ∈ component_present|component_absent|possible_surface_line|no_component, certainty, notes, model}`; segmentation observation `{components[{id, prompt, boxes, objects[{box, confidence, mask{bounds, svgPath}}], width, height}]}`; geometry `registration{status, fitness, surfaceCoverageFraction, rmsDeviationMm, p95DeviationMm, meanDeviationMm}` + `ruleResults[]`.
- **Retry:** Meta calls with timeout + bounded retries; agent dispatch retried with backoff; JobStore keyed `(sessionId, eventId, ruleId)`.
- **Configuration (env):** `META_SCREEN_MODEL=muse-spark-1.3`, `META_REVIEW_MODEL=muse-wonder-1.0`, `META_SAM_MODEL=sam-3.1`, `SAM_CONCURRENCY`, `SAM_MIN_CONFIDENCE`, `META_TIMEOUT_MS`, `META_MAX_RETRIES`, `GEO_MIN_FITNESS`, `GEO_MIN_COVERAGE`, `ANALYSIS_CONCURRENCY`, `VIDEO_ANALYSIS_EVERY`, `VIDEO_SCREEN_MODE`.

## Acceptance

- [x] A photo produces a finding (and a SAM segmentation observation) before `/complete` (mock orchestrator test; live in Docker E2E).
- [x] Scan rules decided from the merged registration with their approved thresholds; insufficient registration → `INSUFFICIENT_EVIDENCE`.
- [x] Model timeout/unavailable yields no verdict; a printed WARNING cap holds.
- [ ] One real finding traced media → SAM mask → Muse observation → gate → pinned quote in the UI (Docker E2E, see notes).

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §9 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §§2,7,9 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §§2,5–6 · Routing: [PRD-10](PRD-10-sam-component-routing.md)

## Test Plan

- pytest: gate thresholds/prerequisites/onFail/severity cap; geometry gate on fitness+coverage; routing with family/type; order context reaches prompts; SAM parsing of a recorded live stream; SAM concepts run concurrently and errors are reported, not treated as absences.
- Vitest (mock orchestrator): live finding before `/complete`; merged-scan GEO-002 verdict with reason.

## Verification

- [x] pytest 46/46, API Vitest 31/31.
- [x] Live SAM 3.1 smoke call recorded (`tests/fixtures/sam_stream_bonnet_bolts.json`).

## Review gate

Implemented on the user's go-ahead of 03 Nov 2026 (issues #8, #10, #11, #13). Edit this file to change scope.
