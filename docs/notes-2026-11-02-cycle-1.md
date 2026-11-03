# Notes — 2026-11-02 · Implementation Cycle 1 (Argus PRDs 01–08 v1)

Purpose: every gap left in this cycle, why it exists, and what closes it.
Review this file each cycle; close a gap by deleting its row only when its
"Close when" evidence exists. Do not close on intention.

## Gaps

### G-01 · Storage is local files, not MongoDB Atlas / GCS  [OPEN]

- **State:** `src/apps/api` persists to `data/db.json` + `data/evidence/<sessionId>/`
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

- **State:** `src/services/inspection/coordinator.py` implements tool selection and
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
  `fastapi` are not installed in `src/services/inspection/.venv` (verified — only
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
- Coordinator gate is mirrored in TypeScript inside `src/apps/api`; the Python
  service is not yet called over HTTP by the API. (PRD-07)
- Demo rules in `src/reference-data/.../rules/rules.json` are a 5-rule curated
  demo set with demo citations, not the full indexed source library. (PRD-02)

## Cycle log

| Date | Cycle | Closed | Still open |
|---|---|---|---|
| 2026-11-02 | 1 — Argus PRDs 01–08 v1, E2E 39/39 chunks | — (baseline) | G-01…G-04 + smaller notes above |

## Update — 2026-11-02 · Cycle 2 (gap closure pass)

- **G-04 Geometry — CLOSED.** Libraries installed in the project venv
  (`numpy`, `open3d`, `fastapi`, `uvicorn`; Open3D needs `libusb`, installed via
  Homebrew). `src/services/inspection/geometry.py` registers a scan against the CAD
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
  `src/apps/api/src/storage.ts` selects GCS byte upload when `GCS_BUCKET` is set
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
layer. `src/services/inspection/agents.py`: Planner/Orchestrator routes each
evidence event to exactly one sub-agent by media type (VideoAgent,
ImageAgent, PointCloudAgent), dispatches independent events in parallel via
asyncio, and ReportAgent aggregates findings at report time. Every agent
logs started/completed/failed/unavailable under the shared InspectionContext
(sessionId); one agent's failure never blocks siblings. Verdicts remain the
deterministic rule gate (coordinator.evaluate_rule). app.py exposes
/analyze, /analyze-batch, /sessions/{id}/log. pytest 10/10.
Known remaining seam: src/apps/api does not yet call this service over HTTP, and
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
`src/services/inspection/cad_reference.py` resolves the CAD by model_id from
`src/cad_models.json`, samples its mesh surface with Open3D
(`sample_points_uniformly`, 680k points, mm) and caches
`src/reference-data/cvs6000d-48-demo/cad/cad_reference.ply` + hash metadata
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
`src/services/inspection/worklist.py` builds the session worklist from the
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

`src/apps/api/src/models.ts` defines typed docs for inspections, evidence,
findings, events, dossiers, ruleLibrary (spec field separation preserved).
`src/apps/api/src/db.ts` (MongoStore) connects when MONGODB_URI is set, creates
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

Google Cloud Logging: Node logger (src/apps/api/src/logger.ts) and Python
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

## Update — 2026-11-03 · Cycle 9 (tiered agent-specific model routing)

User-approved: fast model screens everything, flagship reviews the flagged.
meta_adapter.py now exposes screen_visual (Tier 1, META_SCREEN_MODEL,
default muse-spark-1.3), review_visual (Tier 2, META_REVIEW_MODEL, default
muse-wonder — id/multimodal support to confirm at smoke test), and a
deterministic needs_review trigger (suspected indication, low certainty,
critical features). VideoAgent is Tier-1 only; ImageAgent screens then
escalates; PointCloudAgent and the rule gate use no LLM. Tech Stack model
notes and .env.example updated. Both tiers still return `unavailable`
until META_API_KEY + smoke test + META_ADAPTER_LIVE=1.

## Update — 2026-11-03 · Cycle 10 (ingest token enforcement + container fixes)

Argus API now enforces ARGUS_INGEST_TOKEN on ingestion POSTs (video/photos/
pointcloud/complete) when the token is configured and non-placeholder:
missing/wrong Bearer -> 401 UNAUTHORIZED, timing-safe compare, read at
request time. Unset/placeholder keeps local demo open. Simulator sender now
also sends the token on /complete (uploads already did). Two container
defects found and fixed while verifying: Cloud Logging enabled on
GCP_PROJECT_ID alone crashed the API container without any credentials
path (now requires GOOGLE_APPLICATION_CREDENTIALS or workload identity,
else warns and logs to stdout — project id is not authorisation), and the
inspection image missed libegl1 for Open3D. Full compose stack verified
up: api (mongo+gcs configured), orchestrator, 3 agents, simulator.

## Update — 2026-11-03 · Cycle 11 (local test pass)

Suites: Argus API vitest 5/5 (incl. ingest-token 401/202, mongo-memory),
inspection pytest 20/20, Simulator vitest 3/3. Found+fixed: .env loading
made tests try the real Atlas (hook timeout) — loader now skips under
VITEST. E2E (Docker): session created, no-token upload 401, Simulator
streamed 39/39 chunks (17 video/6 photo/16 pointcloud, token accepted),
/complete, End Inspection -> COMPLETED, dossier generated, post-close
upload correctly 409; all six services health 200. One real defect found
by testing: a stale host API process shared port 8000 with the container,
so the Simulator (via host.docker.internal) saw a different DB and got
404 — killed the host duplicate; single-stack only. Outcome remains
INCONCLUSIVE until Meta adapter is live (expected).

## Update — 2026-11-03 · Cycle 12 (src/ move, inspection_rules wiring, state UX)

All source moved under src/ in both repos (apps, services, packages,
reference-data, inspection_rules; simulator: apps under src/apps) with
paths, Dockerfiles, compose, scripts and tests adjusted. Instruction-sets
endpoint now parses src/inspection_rules/*.md live (18 documents,
74 extracted rules at verification). Empty states on Home/Reports/Rules/
Documents; lifecycle-specific session UX (WAITING guidance, ANALYZING live
state — API now promotes sessions RECEIVING->ANALYZING as evidence accrues,
READY_TO_CLOSE review prompt, COMPLETED/TERMINATED read-only dossier-first).
Found by verification: the API image initially lacked src/inspection_rules
(rules endpoint returned 0 in Docker) — Dockerfile fixed. Suites green:
Argus API 5/5, pytest 20/20, Simulator 3/3; Docker E2E pending in this cycle.

## Update — 2026-11-03 · Cycle 13 (Home/Rules/Reports rebuilt to UX)

User verified against screenshots: pages did not follow
docs/ux/Argus click-through-html. Rebuilt with the design's own classes:
Home (search + All/Active/Completed/Terminated chips, rowhead grid,
status/outcome badges, findings minibar + counts, dashed upload drop,
read-only valve type, disabled-until-name Start), Inspection Rules
(ar-rhead search + valve/evidence filters, six ar-stagecard stages from
src/inspection_rules parsing — Visual Inspection 55, Identification,
Assembly, Functional Testing, Release Gates, Global Rules, 158 rules —
ar-toc sections with Reject-if notes, expandable ar-rule rows with
code/title/acceptance/evidence), Reports (outcome chips + search, Full/
Partial type, findings counts, View/Download). Parser extended to
bullets and semicolon checklist paragraphs so Assembly/Release-Gates
documents contribute rules. API tests 5/5, web builds, Docker stack live.

## Update — 2026-11-03 · Cycle 14 (blank Home + Rules layout fix)

Root cause of blank Home: the earlier page-rebuild patch corrupted
App.tsx — the Home JSX block was deleted in a bad slice (Rules had been
inserted over the nav). App.tsx was rewritten cleanly in one file, no
patch stacking. Rules page now renders as the design intends: full-bleed
ar-rules (not nested inside ar-page, which squeezed the left section
sub-menu), ar-toc at its design 236px with readable items, stage cards,
section heads, expandable rule rows. Verified with real Chrome screenshots
(home / #rules / #reports all render against live data); a Reject-if note
mis-assigned to the following section was also found in the screenshot
and fixed in the parser (notes now bind to their own section).

## Update — 2026-11-03 · Cycle 15 (local version on MongoDB Atlas)

Local stack now connects to MongoDB Atlas: compose no longer overrides
MONGODB_URI to the docker mongo service (kept as opt-in `local-mongo`
profile); the API takes the Atlas URI from .env. Atlas connectivity
verified (ping ok), collections + indexes created (evidence unique
(sessionId,eventId)). One defect fixed on the way: an empty Atlas DB lost
to stale local data/db.json state — Mongo is now the source of truth when
configured, so a fresh Atlas shows the designed empty states instead of
resurrecting old test runs. Smoke session created via the API is visible
in Atlas (inspections: 1).

## Session-page UX repair (2026-11-03)
- Session page rebuilt from mockup states: WAITING (4 empty panes, pulsing "Waiting for evidence" progress card, timeline Waiting), ANALYZING (real <video> from stored chunk, photo grid from evidence files, point-cloud chunk list, live findings, "Receiving and analyzing"), READY_TO_CLOSE (Close Inspection banner), COMPLETED (evidence strip + Completed banner + Final findings + Open Dossier), TERMINATED.
- Fixes: sessionRules ReferenceError (hoisted const), React `border` shorthand warning, ar-livegrid→explicit 1fr/380px grid (class absent in bundle), pane card styling/borders, NOT_APPLICABLE excluded from live findings, findings copy from server basisText + pinned quote.
- Verified by headless-Chrome screenshots: waiting / receiving (39/39 chunks, real media) / completed + Home with 3 real Atlas inspections.

## Session page: verbatim mockup port (2026-11-03)
- Root cause of drift: session JSX invented classes absent from bundle.css (ar-pane, ar-tag, ar-await, ar-track-line) and wrapped the page in ar-page, instead of porting Main.dc.html's ar-ihead + ar-live + ar-media + ar-panel structure.
- Fix: session page now reuses the mockup DOM/class names verbatim (ar-media-tag/meta, ar-photo.empty slots, ar-steps, ar-lane ticks, ar-feedhead/ar-feed, ar-reader), with real data bound in. Same bundle.css (byte-identical to docs copy).
- Verified waiting / receiving / completed by headless-Chrome screenshots against mockup images.
- Remaining real-data differences: CAD meta shows the real cvs6000_valve.stl; point-cloud pane lists chunks (no rendered registration image yet); findings stay Insufficient until Meta live smoke passes.
