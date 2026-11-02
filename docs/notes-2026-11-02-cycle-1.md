# Notes — 2026-11-02 · Implementation Cycle 1 (Argus PRDs 01–08 v1)

Purpose: every gap left in this cycle, why it exists, and what closes it.
Review this file each cycle; close a gap by deleting its row only when its
"Close when" evidence exists. Do not close on intention.

## Gaps

### G-01 · Storage is local files, not MongoDB Atlas / GCS  [OPEN]

- **State:** `apps/api` persists to `data/db.json` + `data/evidence/<sessionId>/`
  + `data/dossiers/*.html`. Spec requires MongoDB Atlas (sessions, evidence,
  findings, events, dossiers) + GCS (original/derived bytes, signed URLs).
- **Why not done:** No `.env` exists in the repo (verified 02 Nov 2026) — no
  `MONGODB_URI`, no GCS bucket/credentials available to this session. The cycle
  prioritised an end-to-end loop (Simulator → Argus → dossier) that runs with
  zero external accounts. Local storage also kept iteration fast and tests
  hermetic (Vitest `app.inject`, no network).
- **Impact if left:** No multi-instance safety, no signed-URL downloads, data
  lost if `data/` is wiped, SSE/event history not durable across processes.
- **Close when:** `.env` provides Atlas + GCS; a storage adapter implements the
  same repository interface; API tests pass against Atlas/GCS (or emulators);
  `data/db.json` path removed. Owner: PRD-04 / PRD-05 follow-up.

### G-02 · Meta Muse Spark 1.3 visual analysis not live  [OPEN]

- **State:** `services/inspection/coordinator.py` implements tool selection and
  the deterministic rule gate over typed observations, unit-tested (pytest 5/5).
  No real model call: observations are never produced from actual media, so
  findings stay `INSUFFICIENT_EVIDENCE` and outcomes stay `INCONCLUSIVE`.
- **Why not done:** No Meta API key/endpoint configured (no `.env`); model
  access, file limits, and structured-output shape were never smoke-tested in
  this environment, and the PRDs forbid fabricating findings without a real
  observation. Sequencing also mattered: ingestion (PRD-04) and the live loop
  had to exist before inference had anything truthful to consume.
- **Impact if left:** No visual findings (nameplate/flange/bonnet) in the demo;
  Argus shows evidence and honest inconclusive results only.
- **Close when:** Meta key in server-side env; one smoke call on a real
  `simulated_data` photo returns a schema-valid observation; coordinator stores
  model version + call ID; a finding in the UI traces to that observation.
  Owner: PRD-07 follow-up.

### G-03 · SAM 3.1 segmentation not live  [OPEN]

- **State:** Coordinator selects `sam_segmentation` when a rule has features,
  but no SAM call is made; no masks/boxes exist.
- **Why not done:** Same blocker as G-02 (no Meta credentials/smoke test), plus
  SAM is only worth wiring after Muse observations exist — SAM localises a
  component for an observation, it never issues a verdict on its own. Doing it
  first would have produced masks with nothing consuming them.
- **Impact if left:** No component localisation/ROI crops; visual analysis (when
  live) works on full frames only.
- **Close when:** SAM call returns a parsed mask/box for one named component on
  a real photo (`meta_sam_parser` or equivalent), stored as a derived artifact
  linked to the observation. Owner: PRD-07 follow-up, after G-02.

### G-04 · Open3D / ICP geometry not live  [OPEN]

- **State:** The geometry gate (`geometry_gate`: units + registration RMSE +
  coverage) is implemented and unit-tested. No point cloud is loaded, no CAD
  reference cloud is generated, no ICP registration or deviation is computed.
- **Why not done:** Three concrete blockers. (1) `open3d`, `numpy`, and
  `fastapi` are not installed in `services/inspection/.venv` (verified — only
  pytest is). (2) The CAD side needs a reference surface point cloud sampled
  from the STL/STEP, which was never generated. (3) Per the Tech Stack §11 open
  question, the prepared scan chunks have no trustworthy externally supplied
  registration pose — so even with ICP code, mm claims would be ungrounded
  until registration quality is validated on the real scan.
- **Impact if left:** Point-cloud chunks are stored and counted, but no
  geometric verdicts; flange/scan rules stay `INSUFFICIENT_EVIDENCE`.
- **Close when:** Open3D installed in the project venv; CAD reference cloud
  generated from `cvs6000_valve.stl`; ICP on a real scan chunk reports RMSE +
  coverage; one feature deviation is shown with uncertainty, or the gate
  demonstrably returns `INSUFFICIENT_EVIDENCE` for an unregistered chunk.
  Owner: PRD-07 follow-up.

## Also noted this cycle (smaller)

- Web polls every 1.5 s; SSE endpoint exists server-side but the client does
  not consume it yet. (PRD-05)
- CAD pane shows pinned reference metadata, not an interactive GLB viewer; GLB
  derivation from the STL/STEP and `features.json` anchors are not built.
  (PRD-02/05)
- Coordinator gate is mirrored in TypeScript inside `apps/api`; the Python
  service is not yet called over HTTP by the API. (PRD-07)
- Demo rules in `reference-data/.../rules/rules.json` are a 5-rule curated
  demo set with demo citations, not the full indexed source library. (PRD-02)

## Cycle log

| Date | Cycle | Closed | Still open |
|---|---|---|---|
| 2026-11-02 | 1 — Argus PRDs 01–08 v1, E2E 39/39 chunks | — (baseline) | G-01…G-04 + smaller notes above |

## Update — 2026-11-02 · Cycle 2 (gap closure pass)

- **G-04 Geometry — CLOSED.** Libraries installed in the project venv
  (`numpy`, `open3d`, `fastapi`, `uvicorn`; Open3D needs `libusb`, installed via
  Homebrew). `services/inspection/geometry.py` registers a scan against the CAD
  reference point cloud taken from the Simulator
  (`simulated_data/CVS_6000D/CAD/valve_CAD_reference_full_surface.ply`, mm, from
  the canonical STEP). Live ICP on the real 180° scan: fitness 1.0, RMSE
  2.321 mm, coverage 0.726, mean deviation 2.058 mm (identity-frame ICP first;
  FPFH/RANSAC fallback — RANSAC alone misaligned at RMSE 155 mm). Note: with
  the rule gate's 2.0 mm RMSE threshold this scan still evaluates
  `INSUFFICIENT_EVIDENCE` until a rule supplies an approved tolerance — that is
  the gate working, not a failure. pytest 7/7.
- **G-01 Storage — CODE-READY, pending credentials.** `.env.template` added
  (Argus + Simulator) with `MONGODB_URI`, `GCS_BUCKET`, credentials, Meta keys.
  `apps/api/src/storage.ts` selects GCS byte upload when `GCS_BUCKET` is set
  (drivers `mongodb`, `@google-cloud/storage` installed) and health reports the
  storage mode. Mongo document migration of `data/db.json` remains open until
  an Atlas URI is filled in and verified.
- **G-02/G-03 Meta — ADAPTERS READY, pending credentials.** `meta_adapter.py`
  gates live calls on `META_API_KEY` + `META_ADAPTER_LIVE=1` and returns
  structured `unavailable` until then; FastAPI surface in `app.py`
  (`/health`, `/analyze`) wires coordinator + geometry + adapters. Close after
  filling `.env` and one successful smoke call.

## Update — 2026-11-02 · Cycle 3 (orchestrator + sub-agents, user-directed)

Supersedes the "one coordinator, tools not personas" shape for the execution
layer. `services/inspection/agents.py`: Planner/Orchestrator routes each
evidence event to exactly one sub-agent by media type (VideoAgent,
ImageAgent, PointCloudAgent), dispatches independent events in parallel via
asyncio, and ReportAgent aggregates findings at report time. Every agent
logs started/completed/failed/unavailable under the shared InspectionContext
(sessionId); one agent's failure never blocks siblings. Verdicts remain the
deterministic rule gate (coordinator.evaluate_rule). app.py exposes
/analyze, /analyze-batch, /sessions/{id}/log. pytest 10/10.
Known remaining seam: apps/api does not yet call this service over HTTP, and
Video/Image agents still return `unavailable` until Meta credentials land.

## Update — 2026-11-02 · Cycle 4 (sub-agents as independent services)

User correctly observed the Cycle-3 agents were classes in one process.
Now each sub-agent is its own HTTP service/process (`agent_service.py`:
video :8101, image :8102, pointcloud :8103), with its own /health and media
boundary (verified: pointcloud service rejects a photo event, and returns
live ICP geometry for a PLY under a caller sessionId). The orchestrator
dispatches over HTTP by default (AGENT_TRANSPORT=http; local in-process
transport remains for tests). `scripts/run_inspection.sh` launches all four
processes; any sub-agent can be killed/restarted alone — the orchestrator's
JobStore retry/recovery (Cycle 3) covers the gap. pytest 11/11.

## Update — 2026-11-02 · Cycle 5 (CAD reference-cloud generator)

Corrected the earlier shortcut: Argus must generate its own comparison
reference from the *given CAD* (derived design intent, not evidence).
`services/inspection/cad_reference.py` resolves the CAD by model_id from
`src/cad_models.json`, samples its mesh surface with Open3D
(`sample_points_uniformly`, 680k points, mm) and caches
`reference-data/cvs6000d-48-demo/cad/cad_reference.ply` + hash metadata
(source SHA-256 e6920218... matches cad_models.json), regenerating only when
the CAD changes. geometry.py now defaults to this generated reference
(CAD_REFERENCE_PLY may still override); the Simulator's
`valve_CAD_reference_full_surface.ply` is retained only as a cross-check
fixture. Live verification: pytest 13/13; the running pointcloud agent,
restarted on the generated reference, registers the real scan at fitness
1.0, RMSE 4.22 mm, coverage 0.580 (vs 2.32 mm on the fixture cloud).
TODO: true STEP import via OpenCascade/OCP for STEP-native CAD; STL is the
current mesh input. Point-cloud stride note: the simulator's PLY splitting
uses a fixed 16-byte vertex layout and should be made header-driven when it
is next touched.

## Update — 2026-11-02 · Cycle 6 (worklist / rule-guided agents)

Agents were rule-guided only by a hand-supplied rule in tests. Now
`services/inspection/worklist.py` builds the session worklist from the
pinned rule pack (4 tasks, REF-R05 excluded as reference-only) and
`Orchestrator.dispatch_evidence` associates each evidence item to its
task(s) by modality + feature hint, dispatching a task envelope (pinned
quote, feature, approved threshold — never a verdict). Agents echo
ruleId + lookFor in every observation; unassociated media is logged, never
analysed against an invented rule. Endpoints: GET /worklist/{model_id},
POST /analyze-evidence. Live check (orchestrator :8100 over HTTP to the
three agent services) returns rule-tagged observations for a photo against
WO-R01..WO-R04. pytest 17/17. The initial live call exposed stale agent
processes running pre-envelope code — restarted all three services.
Remaining seam: the Node API does not yet call /analyze-evidence on upload.

## Update — 2026-11-03 · Cycle 7 (MongoDB models + integration)

`apps/api/src/models.ts` defines typed docs for inspections, evidence,
findings, events, dossiers, ruleLibrary (spec field separation preserved).
`apps/api/src/db.ts` (MongoStore) connects when MONGODB_URI is set, creates
indexes — unique (sessionId,eventId) on evidence, (sessionId,eventSeq) on
events, id/session indexes — loads state from Mongo at startup when present,
and debounced-syncs the API working state into the collections on every
save. Without MONGODB_URI the local-file store remains the dev default.
Verified: vitest 4/4 including mongodb-memory-server tests (duplicate
(sessionId,eventId) rejected; sync/load round-trip), and a live smoke run
against an in-memory Mongo: session created via the API appeared in the
inspections collection with correct indexes present. G-01 Mongo half is
code-complete and tested; closing it fully still needs a real Atlas URI in
.env verified once. GCS byte upload remains env-gated in storage.ts.

## Update — 2026-11-03 · Cycle 8 (Cloud Logging + Docker deployment)

Google Cloud Logging: Node logger (apps/api/src/logger.ts) and Python
cloud_logging.py write structured entries with service + sessionId labels
when GCP_PROJECT_ID is set (.env.example documents GCP_PROJECT_ID,
GOOGLE_CLOUD_PROJECT, GCP_LOG_NAME, LOG_LEVEL, SERVICE_NAME, agent URLs);
locally they fall back to JSON lines on stdout. Env-gated, server-side only.
Docker: Dockerfile.api, Dockerfile.inspection (orchestrator + the three
sub-agent containers), docker-compose.yml for Argus (mongo, api :8000,
orchestrator :8100, video :8101, image :8102, pointcloud :8103) and a
standalone Simulator image/compose (:4173). Verified: both compose files
validate, all images build, Argus stack comes up healthy (api health shows
mongo configured), simulator container serves 200. Cloud Logging itself
verifies once GCP_PROJECT_ID + credentials are filled in .env.
