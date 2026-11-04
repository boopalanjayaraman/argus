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

## Inspection tabs: verbatim mockup port (2026-11-03)
- Applicable Rules, Documents and Dossier tabs were invented layouts; replaced with verbatim Main.dc.html ports (ar-funnel, ar-rule.with-result, Why-these-rules aside; doc chips/search/ar-rows table; in-page ar-paper dossier).
- "Open Dossier" previously linked to the raw server dossier JSON/HTML; it now switches to the in-page Dossier tab, and Download dossier saves the generated file. Reports View does the same.
- /documents now includes pinned CAD baseline + rule snapshot, evidenceId, sha256 and relative received time; tabs are deep-linkable (#session/<id>/rules|documents|dossier).
- Real-data differences vs mockup: funnel counts are the real pinned pack (5/4/4, not 156/114/7); findings remain Insufficient until Meta live smoke passes.

## PRD-09 evidence viewer dialog (2026-11-03)
- ViewerDialog (lazy-loaded three.js): photo (full-res, prev/next, arrows/Esc), video (native controls), point cloud (merged chunks, OrbitControls orbit/zoom/pan, Reset view, chunks+points header). Deep links #session/<id>/photo|video|pointcloud.
- Root-cause find: Simulator PLY chunking hardcoded stride 16 vs declared 17 bytes/vertex, misaligning every chunk after the first and poisoning geometry. Fixed in Simulator (plyStride from header, stale-cache regeneration, test added); Argus parser also clamps over-declared vertex counts and drops non-finite/outlier points.
- Verified: fresh 39/39 stream renders 250,613 points in scan colors; web vitest 7/7, simulator 4/4.

## Pane thumbnails (2026-11-03)
- Point cloud pane now renders the accumulated scan (all chunks merged, latest chunk captioned) instead of a text list; CAD pane renders Argus's generated CAD reference cloud (new sampled endpoint GET /api/v1/cad-models/:model_id/reference.ply?sample=) instead of only the wireframe SVG (kept as fallback).
- Both thumbnails are static fitted renders (no motion); clicking expand still opens the interactive PRD-09 viewer.

## CAD vs scan comparison status (2026-11-03)
- Was not shown because it never ran live: API had INSPECTION_SERVICE_URL but never called the orchestrator; agent services also bound 127.0.0.1 so orchestrator->agent HTTP never worked in Docker (fixed: AGENT_HOST=0.0.0.0 in compose).
- Now: /complete triggers runComparison (async) -> orchestrator /analyze-evidence -> pointcloud-agent downloads chunks via evidence URLs (new resolve_evidence_file) -> Open3D ICP vs Argus CAD reference. Best-fitness registration stored on the inspection; POST /:id/compare re-runs.
- UI: scan pane meta shows coverage% like the mockup, CAD comparison line in the pane, and a CAD comparison block (status/RMSE/coverage/mean deviation, Re-run) in the rail. Real result on Viewer Check: Valid, RMSE 4.053mm, fitness 1.0, coverage 8% (best single chunk), mean deviation 3.701mm.
- Findings still gate at coordinator level (coverage >= 0.3, RMSE <= 2mm), so rule verdicts remain Insufficient until a merged-scan registration passes; comparison status is reported, not converted into a verdict.

## Merged-scan coverage (2026-11-03)
- Comparison now merges all chunks before registration: geometry.register_merged + PointCloudAgent.compare_merged + POST /compare-merged (agent-service and orchestrator) ; API runComparison switched to it.
- Result on Viewer Check: coverage 8% (best single chunk) -> 58.01% (merged, 534,688 scan points), RMSE 4.22mm, mean deviation 3.864mm, status Valid.
- Findings gate unchanged (needs RMSE <= 2mm at rule level): verdicts still Insufficient on this coarse synthetic scan; comparison metrics are reported, not converted.

## Deviation metric correction (2026-11-03)
- RMSE was unsigned nearest-point distance to the CAD *point cloud*, which mostly measures CAD reference point spacing (~3.5mm), not surface deviation. Signed point-to-plane diagnostic: median -0.36mm; point-to-mesh ground truth RMSE 1.899mm.
- geometry.py now computes point-to-plane deviation (signed along CAD normals; RMSE over signed values, meanDeviation = mean |signed|). Live result: RMSE 4.22 -> 2.005mm, mean deviation 3.864 -> 1.519mm, coverage unchanged 58%.
- Earlier claim that the scan came from a different CAD was wrong: same CAD; the offset was our metric.

## Coverage computation correction (2026-11-03)
- Reported 58% was also a computation artifact: coverage marked a CAD point covered only when it was some scan point's nearest neighbor (reverse direction, undercounts under clustering/downsampling).
- Direct CAD->scan distance gives 94.6-94.8%. geometry.py now computes coverage as CAD points within MAX_CORR of the aligned scan. Live: coverage 0.9459, RMSE 2.005mm, mean deviation 1.519mm, status Valid.
- The scan in fact covers nearly the whole valve; earlier "unscanned underside" explanation was wrong.

## Closed-inspection statistics tiles (2026-11-03)
- Completed/Terminated sessions open with a statistics tile row: Total findings, Pass, Warnings, Critical, Laser point cloud coverage (with "CAD comparison succeeded" sub-line), Evidence files.
- Coverage percentage is back on screen (user reversed the earlier hide): rail comparison line also shows "Comparison succeeded · Coverage 95%". Stored geometry: coverage 0.9459.

## Merged video in viewer (2026-11-03)
- New GET /api/v1/inspections/:id/video/merged: ffmpeg concat (stream copy, re-encode fallback) of segments in sequence order, cached by chunk signature, HTTP Range (206) for seeking. ffmpeg added to Dockerfile.api runtime.
- Viewer plays the merged file (33.5s for 17 segments) with a "N segments merged" header; falls back to the last segment on error. Session pane preview unchanged.

## Update — 2026-11-03 · Cycle 16 (review issues #1–#23, user-directed)

Resolved the 23-item review list in one pass across both repos.

- **Rules (#2–#7, #11):** `rules.ts` indexes `src/inspection_rules/*.md` + `rule-metadata.json` into `rule-library.json` (`npm run index:rules`; stale index fails a test). All documents are one manufacturer's set for the demo; equipment narrowing only from rule text (2.6, 8.4, 4.x/5.x/6.x ends). Every session pins a snapshot (`ref-<id>-r<n>`); rules tab, analysis, dossier and reports read only the snapshot. Cascade is real: 161 → 153 (swing check, flanged) → 64 evaluable, +6 with the demo work order. 5-rule demo pack and `/rule-pack` removed. New `inspection_09_cad_scan_conformance.md`: GEO-001…003, DEMO_ONLY thresholds approved by the project owner (fitness ≥ 0.90, coverage ≥ 80 %, RMS ≤ 3.0 mm, p95 ≤ 6.0 mm). Duplicate rule ID `DN65-100` made unique per document.
- **Routing (#1, #10, #13, #16):** `visual-routing.json` v3 — one `Valve` mapping with subtypes listed together, component-level subtype filters, refusal for unmapped equipment (422). SAM 3.1 live via `meta-sam-parser` (boxes, one-bit masks → SVG paths, confidence), parallel concepts, cache, only relevant components prompted; photos downscaled, video keyframes, 1-in-4 segment sampling, decided rules not re-screened from video. Photo viewer overlays SAM masks. PRD-10 written. Whole-word requirement patterns (found live: `Cv` matched inside `CVS48`, wrongly routing WO-R06 as needing a measurement).
- **Order documents (#12, #23):** pypdf (layout) / OOXML extraction in `documents.py`; only rules printed with IDs become session rules (demo work order → WO-R01…R07 verbatim, R07 across a page break, severity caps kept). Upload on Home (multipart create) or while WAITING (`/order-document`, snapshot r2); frozen after first evidence. Work order moved from the Simulator repo to `src/reference-data/cvs6000d-48-demo/customer-documents/`.
- **Live analysis + closure (#8, #9):** `analysis.ts` queue analyses each photo / sampled segment on arrival and re-runs the merged-scan comparison as chunks arrive (coalesced). End Inspection → FINALIZING, drains up to `CLOSE_DRAIN_TIMEOUT_MS`, records the rest as incomplete; Terminate cancels at once. Every write checks the session is open and the job not aborted. Found during E2E: fetching the order file during creation created a legacy snapshot as a side effect (snapshot r2 on a new session) — fixed and covered by a test.
- **SSE (#14):** web uses `EventSource` (auto `Last-Event-ID`), server replays only newer events, heartbeat, 15 s reconciliation poll; 1.5 s polling removed.
- **Dossier (#6):** HTML-escaped; citations `document · section · rule N` (page for order rules); snapshot/library/order hashes, cascade, scan metrics, incomplete analysis, evidence register with hashes.
- **Simulator (#19–#22):** validation shows the real lifecycle and blocks closed sessions; per-source concurrent queues with an in-flight cap; jittered configurable retry; second scenario `CVS3000_VALVE` (same CAD, painted + nameplated evidence) in both registries; spec/PRDs aligned to the registry + computed schedule.
- **Docs (#15, #17):** Agentic Architecture v1.0, Tech Stack v1.0, PRD-02/03/05/06/07/08 v2, PRD-10, both folder-structure docs and PRD indexes refreshed.

- **Docker E2E (CVS3000_VALVE + uploaded work order):** snapshot 161 → 153 → 70 (6 order rules); Simulator streamed 44/44 with sources in parallel; merged-scan comparison ran during the stream (coverage 91.8 % → 94.6 %, RMS 2.0 mm, p95 4.1 mm → GEO-001…003 PASS before `/complete`); photo findings streamed live, e.g. 2.1/10.6 FAIL (nameplate reads SAMSON, order specifies APCO), 4.7 FAIL (no face protector), WO-R02 WARNING (cap held); End Inspection → FINALIZING → drain hit the 30 s window from the local `.env` → last photo cancelled and listed under "Incomplete analysis" → COMPLETED/FAIL; photo viewer showed SAM masks (nameplate 94 %). Fixed from the run: order-rule citation repeated the filename; Simulator reachability badge said "unreachable" before any check and the scenario dropdown did not follow an active run after reload; closed sessions no longer hold an SSE stream.

Suites: API Vitest 32/32, web Vitest 7/7, inspection pytest 47/47, Simulator Vitest 9/9. Live: SAM 3.1 smoke (first call ~83 s cold; in the E2E run 3–9 s per concept).


## Update — 2026-11-03 · Cycle 17 (analyzed video, display only)

- Spike (scratchpad, no repo change): SAM on rendered CAD views recognised only the whole valve (and bonnet bolt heads on a shaded render) — not reliable for labelling CAD parts; the CAD STL splits into 41 bodies, so CAD part boxes should come from geometry (CAD vs scan: linkage parts within ~0–25 mm, flange OD 1511 vs 1514 mm). Photo↔CAD pose from SAM's valve silhouette: IoU 0.85 but ambiguous (0.83 runner-up) — usable only as a labelled "estimated alignment". Proposed as a future PRD; not built.
- Built PRD-11: video viewer gets **Original video** / **Analyzed video** tabs. SAM 3.1 video tracking on a 5 fps proxy (billed per frame) at `/complete` or on demand; FAIL/WARNING findings joined to tracked parts at read time and drawn as "Possible issue / Worth a look" labels; tracking is display-only (excluded from lifecycle, drain and cancel).
- Found while testing (fixed): orchestrator calls used `fetch`, which aborts when response headers take > 300 s — SAM video tracking (~2–5 min for ~10 parts) failed with "fetch failed"; replaced with a node:http helper bounded only by our own timeout. A local IPv4 outage made Docker containers lose internet (host had IPv6 only) — environmental, resolved by switching networks. Label wording kept acronyms ("ID plate", not "iD plate"); labels now one line per part (most serious first, "+N more possible issues on this part") with a connector to the tracked box.
- Simulator test (CVS3000 + work order, `insp-mw111rj6a88d`): 44/44 sent, tracking ran at `/complete` (flange faces, nameplate, body markings, bonnet bolts), 19 possible-issue labels on the analyzed video incl. WO-R02 "thin radial line crosses sealing land" (the work order's planted hairline). Known open issue: rule 4.3 can read as FAIL while the model note says the face is clean (`component_absent` ambiguity for "no X allowed" rules) — reported, not yet fixed.

## Update — 2026-11-04 · Cycle 18 (multi-stage pitch, work-order grouping, README, GCP guide)

- Pitch, spec premise and README reframed as autonomous, continuous, multi-stage inspection (stage CAD, stage rules, history across stages); the build runs stages as separate inspections.
- PRD-12 (display only): inspections grouped by work order + asset ID read from the uploaded order; Home groups them in stage order; **Previous Inspections** tab compares rule results across earlier stages. Live: 4 inspections of `WO-ARGUS-CVS48-001 / CVS48-AC-DEMO-002` grouped.
- `ARGUS_DB_FILE` (optional) lets the working DB file live off the data folder, so `ARGUS_DATA_DIR` can be a Cloud Storage FUSE mount on Cloud Run.
- New `docs/deployment/GCP_Deployment.md`: Cloud Run ×6, Artifact Registry, Secret Manager, bucket mounted into the API, Direct VPC egress + Cloud NAT static IP for Atlas, single-instance API/orchestrator, hardening notes.
- README rewritten (problem, cost, multi-stage, solution, data sources, Meta models incl. Muse Code, architecture, stack, run/deploy, learnings, limits). Muse Code learnings left for the team to fill in.

## Update — 2026-11-04 · Cycle 19 (first GCP deployment)

- Deployed to `project-argus-513519`, `us-central1`, images tag `20261104-0154` in Artifact Registry `argus`: Cloud Run `argus-api` (public, 1 instance, CPU always on, `project_argus_bucket` mounted at `/app/data`), `argus-orchestrator` (internal, 1 instance), `argus-video-agent` / `argus-image-agent` / `argus-pointcloud-agent` (internal), `argus-simulator` (public). Secrets `META_API_KEY`, `MONGODB_URI`, `ARGUS_INGEST_TOKEN`; service accounts `argus-api`, `argus-inspection`, `argus-simulator`; VPC `argus-vpc` / subnet `argus-run` with Direct VPC egress, Cloud NAT static IP `34.67.207.216`.
- Verified: API healthy; simulator lists both scenarios; API → internal orchestrator → evidence download back through NAT → work order parsed (WO-R01…R07).
- Found and fixed while deploying: with the bucket mounted, `GCS_BUCKET` made the API write every file twice to the same object key and a concurrent reader got a truncated PDF — removed `GCS_BUCKET` from the cloud API; guide updated.
- Pending: MongoDB Atlas must allow `34.67.207.216` (API currently falls back to its local store); then restart `argus-api`.
- Local note: this network's IPv6 path to Google APIs was down and gcloud hung on connect; gcloud commands were run with a session-only IPv4-preferring Python hook (`CLOUDSDK_PYTHON_ARGS=""`, `PYTHONPATH` → `sitecustomize.py`).

## Update — 2026-11-04 · Cycle 20 (speed, cloud fixes, PDF dossier, rules page)

- **Speed:** visual items 3 → 6 in parallel (`ANALYSIS_CONCURRENCY`), model-call thread pool 32 in orchestrator and agents (`MODEL_CALL_THREADS`; the default pool was ~5 on 1–2 vCPU), agent HTTP timeout 300 s, SAM warm-up at inspection creation. First measurement (Scenario 2 + work order, local): 713 s → 647 s — but `docker-compose.yml` still pinned `ANALYSIS_CONCURRENCY` to 3, so only the thread-pool change was live. Rate limits checked directly: the Meta API reports 3,000 requests / 4M tokens per window and a 30-call parallel burst returned 30 × 200 in 14.6 s (single calls 6–13 s) — no rate limiting. Compose and `.env.example` defaults corrected to 6; re-measured below.
- **Cloud "stuck in Analyzing":** server reached READY_TO_CLOSE at 21:39 (5 min); the UI did not show it. Home never refreshed and the session refresh dropped all updates if any one request failed. Fixed: Home refreshes every 10 s; session refresh uses allSettled; reconciliation poll 10 s.
- **Cloud MongoDB:** the API connected only at startup (before the NAT IP was allow-listed) and never retried; health reported "mongo: true" from configuration. Fixed: health reports the real connection; retry every 30 s with a merge of local and stored state on first success. Local stack now defaults to database `argus-local`; the cloud uses `argus` (two APIs must never share one — each rewrites whole collections on save).
- **Fewer passes in the cloud run:** that run was Scenario 1 without the work order (6 order rules out of scope) plus model variance on 7.6.
- **Dossier PDF:** ReportAgent (`dossier_pdf.py`, ReportLab) renders the frozen dossier data at closure; `GET /api/v1/inspections/:id/dossier.pdf` (built on demand for older dossiers); all dossier downloads are PDF. Verified: 13-page PDF for a Scenario 2 run.
- **Inspection Rules page:** expanded rows overflowed (rule-meta column could not shrink below long filenames); fixed with shrinkable column + wrapping — all 161 rules expanded in a browser with no overflow. Total "161 rules · 19 documents" shown next to the title.
- **UI:** "Prototype: run simulated feed" removed; findings panel wider (clamp 420–620 px); newest-first live feed with highlight-and-fade and "Analyzing…" cards.
- **README:** new section 2 — applicable ETO / high-mix industries.
- **Re-measured with 6 in parallel (local):** Scenario 2 + work order ready to close in **327 s** (was 713 s); findings comparable (15 pass / 7 warning / 10 fail / 7 insufficient).
- **Cloud updated** to images `20261104-1543` (agents, orchestrator, API; simulator unchanged). Cloud API reached Atlas `argus` on the first 30 s retry; PDF dossier built on demand via the cloud ReportAgent (3 s).
- **Incident (fixed):** switching the local stack to the empty `argus-local` database made the API discard its local file at startup ("MongoDB is the source of truth even if empty", Cycle 15). Local inspections that had never reached Atlas (network outage) vanished from local Home. Restored from a copy of the local state taken earlier the same day, merged into `argus-local` with the API stopped (12 inspections). Open question for the team: keep "empty MongoDB wins at startup", or merge a non-empty local store into an empty database.
- README learnings: "By the numbers" (usage to date: ~7.7k video frames and 996 images segmented by SAM 3.1, ~4k requests, ~6.6M input / ~3.5M output tokens; Muse image calls 9–13.5 s).
- **Auto-close (demo, 04 Nov):** an inspection now ends itself `AUTO_CLOSE_MS` (default 5 s) after it reaches Ready to Close (feed complete, all gating analysis done); dossier + PDF are built as with End. SAM video annotations are display-only and keep running in the background. `AUTO_CLOSE_MS=-1` restores the manual End step. Deployed to cloud (`argus-api:20261104-1625`).
- **Cloud media 404s:** the 5 inspections dated 3 Nov in Atlas `argus` are early smoke tests whose files never reached the bucket ("evidence bytes not found"). New cloud runs store files in the bucket and display normally.
- **AI summary and recommendation (04 Nov):** after closure the API sends the frozen dossier data to the orchestrator (`POST /inspection-summary`), which asks Muse Wonder 1.0 for a ≤ 90-word reasoning summary, one recommended action (Proceed to sign-off / Review before sign-off / Hold for rework / Collect more evidence; anything else falls back to Review) and up to 3 next steps. Stored as `inspection.aiSummary`, shown at the top of the completed inspection page labelled AI-generated; `POST /api/v1/inspections/:id/summary` regenerates. Advisory only — never changes a rule status. Measured ~40 s on Scenario 2 (recommended Hold for rework: nameplate mismatch, flange-face line for NDT, missing test records).
