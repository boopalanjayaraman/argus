# Argus — Live Multimodal Inspection MVP Specification

**Repository:** `argus`  
**Intended repo document:** `SPEC.md`  
**Version:** 0.4 — instructions library, session history, explicit closure and dossier  
**Status:** Proposed for implementation  
**Last updated:** 2026-11-01

## 1. What we are building

**Argus is the real inspection product**, not the simulator. An operator creates a named inspection, Argus waits for evidence, and the screen comes alive as external sources send video, photographs, and laser point-cloud data. Argus combines that evidence with an **approved CAD reference and engineering rules**, evaluates inspectable conditions, and continuously publishes evidence-backed findings.

**One-sentence demo:** *Start an inspection, press Send Simulated Data in a separate app, and watch the digital valve, live video, 3D scan, photographs, and rule-cited pass/warning/fail feed update together.*

### Hard boundaries

- The `argus` repo has **zero dependency on the simulator code or database**.
- It accepts evidence sent by any client that follows the documented API: simulator, prerecorded video uploader, or future camera/scanner adapters.
- It **does not** generate synthetic videos, synthetic point clouds, or ground-truth defect labels.
- Inspection findings must be produced by **Argus's own analysis** of incoming content plus approved rules; never trust a sender-supplied result.
- No login, sign-up, organizations, user roles, project management, or customer onboarding in the MVP.

## 2. Deliberate hackathon decisions

| Decision | MVP choice | Reason |
|---|---|---|
| CAD and inspection rules | **Preloaded from `data/reference/` on startup** | Avoid document administration during the live demo |
| Rules upload UI | **Not required** | A static, versioned baseline is enough for one valve demonstration |
| Media upload UI | **Small optional upload panel** | Proves Argus also accepts real, prerecorded MP4/JPG/PLY files without the simulator |
| Inspection persistence | **SQLite + local file/object storage** | Lightweight; enables history, reload and traceability |
| Login/auth | **None for local demo** | Faster operator flow; don't publicly expose an unauthenticated ingestion server |
| Display updates | **Server-Sent Events (SSE)** | One-way live findings/progress to the browser without unnecessary complexity |
| Production-scale integrations | Deferred | No RTSP drivers, QMS/PLM/ERP, distributed queues, X-ray/CT in this MVP |

> **Important:** Preloaded reference files should include the original CVS 6000D STEP CAD, an exported browser-viewable mesh, and a rule pack with applicability and citations. The previously shared SAMSON instructions may inform *generic inspection requirements* but their model-specific dimensions, torques, and leakage tolerances must not be applied automatically to the CVS valve.

## 3. User experience (the product)

### 3.1 Global navigation and app shell

A minimal persistent navigation bar with **Home**, **Instruction Sets**, and the **Argus** identity. **New Inspection** is a primary action, not a multi-page wizard. During a session, show a small status pill and an always-accessible **End Inspection** / **Terminate Now** action. No login or user/account menu.

### 3.2 Home `/` — new inspections and history

The home page is a useful inspection dashboard from the first launch onward:

- Product title **ARGUS — Autonomous Industrial Inspection**, one-sentence explanation, prominent **Start New Inspection** action.
- **Recent / All Inspections** list loaded from SQLite, newest first. Show: **inspection name**, **created / started date and time**, **session lifecycle status** (Waiting, Receiving, Analyzing, Ready to Close, Completed, or Terminated), **inspection outcome** when known (Pass / Warning / Fail / Inconclusive), and compact finding counts (e.g. 4 Passed · 1 Warning · 0 Failed). Counts derive from persisted findings, not simulated metadata.
- Clicking an **active** session opens `/inspections/{sessionId}` and restores the live workbench. Clicking a **closed or terminated** session opens `/inspections/{sessionId}/history`, a read-only inspection history with the evidence timeline, archived findings and link to its dossier.
- **Start New Inspection** opens a simple name input or inline dialog, creates the SQLite session (with a reference CAD/rule-set snapshot pinned at creation) and immediately navigates to the live workbench in the **Waiting for data** state.
- No login, projects, filters beyond a basic optional name search, approvals workflow, or mandatory uploads.

Example compact list:

| Inspection | Started (local time) | Session | Outcome | Findings |
|---|---|---|---|---|
| CVS Blue Valve — Run 02 | 01 Nov 2026, 14:22 | Completed | Warning | 8 Pass · 2 Warning |
| CVS Grey Valve — Run 01 | 01 Nov 2026, 13:30 | Terminated | Inconclusive | 2 Pass · 1 Warning · 5 Unchecked |
| CVS Blue Valve — Recheck | 01 Nov 2026, 15:10 | Waiting | Pending | — |

*Example rows are illustrative UI data, not actual inspection results.*

### 3.3 Instruction Sets `/instruction-sets` — read-only reference library

**Instruction Sets** is a top-level menu item, implemented as a searchable, read-only reference screen. It reads the same curated source files and structured rules used by the engine. **Do not build a rules-upload or editing UI for the MVP.**

- On startup, load the approved `data/reference/cvs6000d/instruction-sets/` folder. Discover each document's category, printed standard/document number, title, revision, source file, parsed sections and machine-readable inspection rules.
- Present **tabs grouped by document/category**, e.g. `ASME / FCI Rules (N)`, `Assembly Instructions · No. 1.1.1 (N)`, `Test Instructions · No. 2.1.1 (N)`, `Inspection / ITP Rules (N)`. `N` is the **actual number of loaded, applicable rule records** from that source, never a hard-coded badge or invented figure. Show tabs only for source packs actually present.
- Under each tab, show rule cards or a small table with the **source rule / section number** parsed from the instruction file (e.g. `3.3.7` for the seventh item of section 3.3, or a vendor-provided rule number if one exists), title, expected condition, feature, applicable equipment/standard, evidence type, and **verbatim cited source excerpt with source page/section**. Preserve the document's printed number separately from internal rule IDs; do not imply an original document uses identifiers the application derived.
- Allow opening the source document/preview (or an extracted text view) and jumping from a rule to its exact section. Show `Source: SAMSON Works Standard No. 2.1.1 · Final Inspection Checklist §3.3 · Sheet 8` when supported by the file.
- Link a finding's rule citation directly to `/instruction-sets/{sourceId}?rule={ruleId}` so a reviewer can inspect why Argus chose its finding.
- Distinguish **source reference** from **applicable acceptance criterion**. The supplied SAMSON documents are generic/other valve families; their model-specific torque, stroke or pressure thresholds **must not automatically apply** to the CVS 6000D. An ASME rule is shown as applicable only if its actual source and governing scope were supplied and mapped to this demo. Don't fabricate ASME text, clause numbers or permissions to redistribute proprietary full standards.
- An empty folder / unrecognized source shows a clear **No instruction sets loaded** message; Argus may still receive evidence but must not invent rule-based passes.

This library is for human reference. The actual evaluation engine uses the corresponding versioned `rules.json` / extracted rule records, and each session pins the reference-pack ID/version/checksum so past findings remain auditable after files change.

### 3.4 Live inspection workbench `/inspections/{sessionId}`

Open immediately after starting an inspection. Reference CAD and **Waiting for inspection data** appear before simulator activity. The operator can copy the session ID; the simulator sends its prepared media through the documented APIs. As evidence arrives, all visual panes update **without page refresh**.

| Area | Waiting state | During receipt and analysis |
|---|---|---|
| **CAD reference** | View the correct STEP-derived mesh and name of pinned baseline | Rotate/zoom, highlight inspected features, show localized deviation markers where grounded |
| **Live video and photographs** | Awaiting camera / no captures yet | Incremental MP4 segment playback or preview, photo thumbnails and fullscreen captures tied to evidence IDs |
| **3D point cloud** | Awaiting laser scan | Accumulate PLY/PCD chunks, show scan coverage, alignment validity and optional CAD overlay |
| **Live findings feed** | No checks evaluated yet | Real PASS / WARNING / FAIL / INSUFFICIENT_EVIDENCE / NOT_APPLICABLE findings with severity, rule citation, observed evidence, feature/location and timestamps |
| **Timeline and source state** | Session open, feeds idle | Media arrivals, processing stages, completed checks, gaps, latest events and feeder-complete state |

Selecting a finding synchronizes its photo/video timestamp, CAD location and corresponding point-cloud evidence where available. Never pretend analysis is complete merely because a video frame was displayed; show **Analyzing...** until actual processing completes.

**Always available session controls** (top-right, clearly differentiated):

- **End Inspection** — operator requests a *normal close*. Stop new ingestion, allow accepted queued/in-flight analysis to finish (bounded timeout), then finalize findings and generate the inspection dossier. Shows brief `Finalizing report` state. Can be used even if the simulator has not sent its final `/complete` signal.
- **Terminate Now** — *abrupt/early close*, available even from `Waiting`, e.g. during a broken feed. Ask for confirmation to avoid accidental termination, stop accepting new uploads immediately, cancel outstanding analysis where possible, retain received evidence/finished findings, and generate a **partial, explicitly terminated dossier**. Mark missing/unprocessed checks `INSUFFICIENT_EVIDENCE` / `NOT_INSPECTED`, never PASS. Record termination timestamp and optional reason.
- Both are idempotent. After closure, redirect to **Dossier** and expose a **View History** link. Do not silently delete any evidence. Closed sessions cannot be reopened to ingest new media; users create a new inspection for a repeat.

### 3.5 Inspection history `/inspections/{sessionId}/history`

A read-only replay/inspection record, linked from the home list, displaying:

- Session title, dates, duration, lifecycle state, overall disposition and applicable CAD/rule-set versions.
- Received evidence sorted on a timestamped timeline; thumbnail/video, photo gallery and reconstructible 3D point-cloud view when stored data are available.
- Final findings and their citation/evidence links, including revisions if a warning was resolved by later evidence.
- **Open Dossier** button and optional export action. Historical views must not re-run the inspection AI or change persisted outcomes on ordinary page load.
- For an active session reached from Home, route to the live workbench instead; a historical partial session must be clearly marked `Terminated` / `Incomplete`.

### 3.6 Automatic dossier `/inspections/{sessionId}/dossier`

Argus **automatically creates a dossier when the operator closes or terminates an inspection**, including a no-evidence session. HTML is required for the MVP; print-to-PDF from browser is sufficient for hackathon (server-generated PDF optional, not a launch blocker).

Dossier contents:

1. Inspection identification: name, unique ID, lifecycle status, started/closed timestamps, operator action (`normal_close` or `terminated`), termination reason if entered.
2. Reference baseline: CAD filename/version/hash, rules snapshot, instruction-set titles/revisions, and relevant document/standard references.
3. **Overall conclusion:** `PASS`, `WARNING`, `FAIL`, or `INCONCLUSIVE` based on evaluated criteria and configured decision rules; **never mark an incomplete/terminated inspection as fully PASS**.
4. Totals: rules evaluated, PASS/WARNING/FAIL counts, insufficient/not-inspected count, missing evidence and coverage limitations.
5. Detailed findings: feature, observed condition or measured deviation, rule ID, *exact source quotation and page/section*, affected CAD part/region, confidence or measurement uncertainty, supporting images/video timecodes/point-cloud screenshots, decision rationale.
6. Evidence register: timestamp, source, media type, immutable file identity/checksum and any synthetic-source disclosure.
7. Inspection activity timeline, feeder completion status, partial-data caveats and finalization timestamp.

Create a **frozen final result snapshot** in SQLite and persist a report artifact or reproducible HTML representation; the report must render immediately when closure processing finishes and remain accessible from Home → History. Keep all cited text tied to the pinned instruction-set snapshot, even if reference files later change.

### 3.7 Optional manual evidence upload

A modest **Upload Evidence** drawer on the workbench (MP4, JPG/PNG, PLY/PCD). Upload uses exactly the same ingestion and analysis paths as API-submitted media. It's not required in the main demo. No asset-management console.

### 3.8 Lifecycle contract — producer completion is not inspection closure

The simulator's `POST /complete` means **the producer sent its final file**, not that Argus completed inspection or generated a dossier. Argus must finish its queued analysis and transition to `READY_TO_CLOSE`. **The operator remains in control of closing or terminating the session.**

| Lifecycle state | Meaning | Accept new evidence? | Operator action |
|---|---|---|---|
| `WAITING` | Created; awaiting first evidence | Yes | End / Terminate |
| `RECEIVING` | Receiving one or more evidence streams | Yes | End / Terminate |
| `ANALYZING` | Processing evidence; may also receive it | Yes | End / Terminate |
| `READY_TO_CLOSE` | Sender finished; remaining analyses drained | No further simulator data expected; manual uploads may be blocked | End / Terminate |
| `FINALIZING` | Closing: no new evidence; drain/cancel jobs, freeze findings, generate dossier | No | None (wait for finalized result) |
| `COMPLETED` | Operator ended inspection normally; dossier exists | No | View history / dossier |
| `TERMINATED` | Operator aborted early; partial dossier exists | No | View history / dossier |

Keep separate fields for **lifecycle status**, **finding status**, and **overall inspection outcome**. `READY_TO_CLOSE` is not equivalent to `PASS`. Normal closure before a producer complete signal is permitted but must disclose truncated acquisition and may produce `INCONCLUSIVE`.

## 4. Reference baseline (read from folder, no upload required)

```text
data/reference/cvs6000d/
  original/cvs-6000d-48-f1-ac.stp       # unmodified, approved CAD
  viewer/cvs6000d.glb                  # pre-converted viewer mesh
  features.json                        # IDs/locations for known features
  rules.json                           # machine-readable, applicable rule definitions
  instruction-sets/                     # source documents and extracted catalog
    instruction-sets.json               # tabs, source IDs, printed document numbers and revisions
    assembly/                           # e.g. SAMSON assembly instructions + extracted sections
    testing/                            # e.g. SAMSON test instructions + extracted sections
    asme/                               # only duly supplied and applicable source excerpts/rules
    itp/                                # approved demo work order / inspection plan / rules
  sources/                              # retained originals/excerpts, provenance and citations
  reference-manifest.json              # version, hashes, CAD units, rule source versions
```

Each rule **must** specify `ruleId`, feature, requirement and/or comparison method, applicability, source title + exact section/page/excerpt, expected value or condition, optional tolerance, and evidence modality. The system displays the cited text **from the reference pack**, not an invented citation. The application should be able to explain a rule in plain English while retaining the original excerpt.

**MVP test rules (only when evidence supports them):** expected assembly components/fasteners, visible surface indications, flange geometry versus CAD, linkage position/registration, and nameplate text versus demo work-order values. Avoid automatically passing unobserved features. Do not claim real crack depth, leak tightness or bolt torque from images alone.

## 5. External ingestion API — canonical contract

Argus owns the **versioned API specification**. Simulator is an independent client of it. The v1 MVP may use standard HTTPS file uploads (multipart/form-data) with a small JSON sidecar; no sockets or device SDK required on the sender.

```http
POST /api/v1/inspections                         # { "name": "..." } -> { sessionId, status }
GET  /api/v1/inspections/{sessionId}             # header/state
GET  /api/v1/inspections/{sessionId}/events      # SSE: UI progress and findings
POST /api/v1/inspections/{sessionId}/video       # video segment + metadata (one segment at a time)
POST /api/v1/inspections/{sessionId}/photos      # JPG/PNG + metadata
POST /api/v1/inspections/{sessionId}/pointcloud  # PLY/PCD chunk + metadata
POST /api/v1/inspections/{sessionId}/complete    # no more evidence expected
GET  /api/v1/inspections/{sessionId}/evidence
GET  /api/v1/inspections/{sessionId}/findings
GET  /api/v1/inspections                         # home history: name/date/status/outcome/counts
GET  /api/v1/instruction-sets                    # list groups, source numbers, revisions, rule counts
GET  /api/v1/instruction-sets/{sourceId}         # catalog, extracted rules, citations, source preview metadata
POST /api/v1/inspections/{sessionId}/close       # operator normal close; finalize, generate dossier
POST /api/v1/inspections/{sessionId}/terminate   # operator abort; partial dossier, stop ingest/analysis
GET  /api/v1/inspections/{sessionId}/dossier     # frozen report HTML or JSON representation
GET  /api/v1/inspections/{sessionId}/history     # read-only session summary and timeline
```

**Session closure semantics:** `/complete` is producer-end-of-stream only, **not** inspection closure. `/close` and `/terminate` are initiated by Argus's operator UI (the simulator never invokes them). Reject new evidence for `FINALIZING`, `COMPLETED` or `TERMINATED` with `409 SESSION_CLOSED` and return the final session status; honor already-received idempotent event IDs without duplication. Make close/terminate transitions transactional and idempotent so in-flight uploads cannot cause a report to omit already-acknowledged evidence. If a normal close occurs with no producer-complete signal, record the stream as truncated/incomplete. `/terminate` prioritizes immediate closure; bounded cancellation and `NOT_INSPECTED` status for unfinished checks are mandatory.

Example operator call: `POST /api/v1/inspections/insp-123/terminate` with `{ "reason": "Operator stopped during scan" }`. This returns state `FINALIZING` followed by `TERMINATED`, and the dossier URL once persisted. Same pattern for `/close` and `COMPLETED`.

**Instruction Set read API:** list and detail endpoints are read-only; category tabs and rule counts are derived from the prepared source catalog and indexed rules. Rule links must resolve to the exact version pinned to the session, not whatever happens to be loaded today.

**Multipart upload:** field `file` contains bytes; field `metadata` contains JSON. Each API returns `{ evidenceId, accepted: true, processingStatus: "queued" }` as soon as the file has been stored, **not** a fake inspection result. Argus asynchronously analyzes content and emits updates over SSE.

**Required common metadata:** `eventId` (unique for idempotency), `sourceId`, `sequence` (within source), `capturedAt` or `relativeTimeMs`, `mediaType`, `synthetic` (boolean provenance), optionally `featureHint`. For point clouds additionally require `units`, `coordinateFrame`, and `pose`/alignment metadata if available. Unknown alignment => render scan but mark CAD comparison inconclusive.

Example `metadata`:

```json
{
  "schemaVersion": "1.0",
  "eventId": "sim-0042",
  "sourceId": "laser-01",
  "sequence": 42,
  "relativeTimeMs": 14600,
  "mediaType": "pointcloud",
  "synthetic": true,
  "units": "mm",
  "coordinateFrame": "cad_world",
  "featureHint": "front_flange"
}
```

**Video:** The sender can stream pre-split MP4 segments (e.g., 1–2 seconds each) in sequence; Argus exposes the latest segment for browser playback and extracts inspection frames on the backend. Optionally emit JPEG preview frames using the photo endpoint tagged `captureKind: "video_frame"`. **Original recordings** can be accepted through the same video endpoint as a single larger file (processed asynchronously). Don't attempt to push a raw RTSP feed through the API in the MVP.

**Resilience:** acknowledge after storing evidence, keep independent source sequences, reject unsupported files and invalid units, and de-duplicate by `eventId`. If footage/scan arrive out of order, align by captured timestamp when possible; otherwise report limitations.

## 6. Actual analysis — must run inside Argus

**Processing loop:** receive media → save evidence → publish arrival event → decode/parse → identify relevant features → evaluate with available modality + applicable rule → produce or update findings → emit SSE → persist.

- **Photos and video frames:** inspect visible appearance, component presence, fastener state, nameplate OCR, plausible surface indications. Use image models/CV as appropriate; label marginal observations as WARNING, not guaranteed defects.
- **Point clouds:** parse and accumulate chunks; align or use known coordinates; compare registered points with CAD within defined tolerances; recognize coverage gaps/occlusions. Never treat lack of a return as proof a part is missing.
- **Multimodal fusion:** attach all supporting evidence to one feature/rule; update an earlier inconclusive finding when new evidence arrives; preserve version/history of the outcome.
- **Rules:** deterministic measurement/threshold checks when justified; language models can explain and cite grounded rules but must not fabricate measurements or acceptance criteria.

### Finding record (minimum)

```json
{
  "findingId": "f-001",
  "sessionId": "insp-123",
  "ruleId": "ASSEMBLY-BONNET-001",
  "featureId": "bonnet_bolt_ring",
  "status": "WARNING",
  "summary": "One bonnet fastener appears inconsistent with surrounding fasteners",
  "ruleCitation": {"document": "Demo ITP", "section": "4.2", "excerpt": "Verify bonnet fasteners are present and properly seated."},
  "evidenceIds": ["photo-08"],
  "observedAt": "2026-11-01T13:10:00Z",
  "rationale": "Visual indication only; torque and seating height not yet measured",
  "confidence": 0.73
}
```

Statuses: `PASS` (demonstrably meets criterion), `WARNING` (suspected/partial), `FAIL` (criterion exceeded with adequate evidence), `INSUFFICIENT_EVIDENCE` (not observable/quantifiable), `NOT_APPLICABLE`. Analysis confidence is **not** measurement accuracy.

## 7. Lean storage model

**SQLite tables:** `inspections` (name, lifecycleStatus, inspectionOutcome, createdAt, startedAt, closedAt, closureMode, terminationReason, referenceSnapshotId, feederCompleteAt), `evidence` (session/type/path/hash/metadata/receivedAt/processingStatus), `findings` (rule/feature/status/rationale/citation/evidence refs/updatedAt), `events` (immutable timeline), and `dossiers` (sessionId, generatedAt, snapshot JSON, HTML path, `isPartial`, content hash). Files live under `data/inspections/{sessionId}/`. No user/account tables. Preserve rule-citation snapshots at session start so historic dossiers do not drift when folder rules change.

SQLite is **not strictly necessary for a throwaway live demo**, but it is worth including: minimal implementation work, deterministic reloads, persistent findings, and a more credible product experience.

## 8. Suggested implementation (not mandatory)

- Web: React + TypeScript, clean responsive UI; 3D via Three.js/React Three Fiber or similar; point cloud via Three.js point primitives.
- API / analysis: Python FastAPI for file receipt, geometry processing, OCR/CV/LLM adapters, SSE and SQLite.
- Store videos/images/scans on local disk; use background workers/tasks with bounded concurrency.
- Preprocess STEP into GLB and rule fixtures **offline before the demo**, not when pressing Start Inspection.
- No authentication for **local or trusted temporary-demo deployment**; if exposed on the internet, add a simple server-side API token/network restriction, not an elaborate login product.

## 9. MVP demo acceptance criteria

1. On the home page, entering a name and pressing **Start Inspection** creates a persisted inspection and shows `Waiting for evidence` plus the CAD immediately.
2. A client using only the public API sends video segments, captured photos, and point-cloud chunks; Argus accepts all three without simulator-specific code.
3. Visible camera feed advances, captured photos appear in sequence, and a 3D point cloud builds incrementally **on the same page**.
4. Actual inspection processing generates live findings with correct rule excerpts, feature labels and clickable supporting media; statuses do not arrive from the simulator.
5. Missing registration, insufficient image detail or ambiguous cracks lead to WARNING/INSUFFICIENT_EVIDENCE, not an invented hard FAIL.
6. Home lists persisted inspection names, date/time, lifecycle status, outcome and finding summary. Clicking an active session opens live inspection; clicking completed/terminated sessions opens read-only history.
7. Instruction Sets menu shows folder-backed source-category tabs, printed document numbers, **computed rule counts**, source quotes and clickable rule IDs; historical citations resolve to pinned source versions.
8. `/complete` from simulator transitions the feed to ready for operator closure; **does not** close inspection or generate a dossier.
9. **End Inspection** generates a stored dossier with actual findings and links to evidence; Home and History can reopen it.
10. **Terminate Now** works from Waiting, Receiving or Analyzing; blocks new data, captures an incomplete dossier, and never upgrades missing checks to PASS.
11. A real MP4/photo/PLY can be uploaded from the Argus interface and processed by the same pipeline.
12. The simulator may be shut down entirely without preventing Argus from accepting evidence from any other API client.
13. Closed-session upload attempts receive a consistent `SESSION_CLOSED` response and cannot mutate the frozen dossier.

## 10. Explicitly deferred

Rule/CAD upload UI, login, user roles, multi-customer projects, scheduled inspections, on-device camera capture, RTSP/WebRTC native adapters, fully general CAD interpretation, X-ray/CT, advanced NDT physics, QMS/ERP integrations, production multi-tenancy, large-scale streaming infrastructure, or claims of certified physical inspection.

**Companion but independent repo:** `argus-simulator` — pre-generated file streaming only. The Argus API described above is the sole integration contract.
