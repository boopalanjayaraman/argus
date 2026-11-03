# ARGUS — Feature Specification (MVP)

**Repo:** `argus`  
**Version:** 0.9 · 02 November 2026  
**Status:** Hackathon MVP feature requirements  
**Companion:** `argus-simulator/SPEC.md` v0.9 — independent prepared-evidence sender  
**Purpose:** Standalone specification of Argus product features, required behaviors, data contracts, implementation boundaries, and acceptance criteria.

## 1. Product premise

**Argus is an autonomous industrial inspection workbench for engineer-to-order (ETO) equipment.** One-off, high-value assets must be checked against *the approved design and order-specific instructions*, rather than a standard stock-product visual template. Evidence may arrive while an asset is being built. Argus progressively interprets real camera clips, photographs and laser point clouds, compares observations with a referenced CAD assembly and applicable inspection rules, and produces a traceable dossier for human review.

The value proposition is **fewer high-consequence missed deviations, earlier detection of rework, and defensible inspection traceability**. The hackathon demonstrates the software capability on a prepared 48-inch swing-check-valve scenario; it does not claim qualified metrology, guaranteed detection, robot/gantry control, or industrial certification.

**Meta alignment:** “Push the Frontier” — Meta multimodal models reason about an actual engineering object and its supplied rules, grounded by computer vision and deterministic geometric measurements. Models inform observations, not fabricated numeric tolerances or automatic manufacturing release.

### Explicitly out of scope

- Acoustic analysis or valve-hiss fault detection; audio is **not** a media source or agent in this MVP.
- Generating source media inside Argus; camera footage, photos and point clouds are externally produced (or already prepared and supplied by the independent simulator).
- X-ray, CT, ultrasonic/NDT, pressure tests, physical leak tests, torque measurement, automatic equipment actuation, robotic scan paths and PLC integration.
- Login, user management, approval workflow, multi-tenant orchestration, mandatory on-screen standard/CAD upload, QMS/ERP integration.
- Hardcoded demo findings, “perfect equipment” claims from incomplete visual coverage, invented ASME quotations, or a pass based merely on absence of detected objects.

## 2. Product Functional Areas and Navigation

The product provides inspection-session management, an indexed inspection-rule library, real-time evidence monitoring, rule evaluation, and persistent inspection dossiers. A compact, dark-themed operations interface supports these capabilities; implementation correctness is defined by the functional requirements below.

**Primary navigation:** `Argus` brand • **Home** • **Inspection Rules** • **Reports**. No login or separate “Projects” page. Each session has its own tabbed detail view.

**Routes** (implementation can adjust route syntax while retaining behavior):

| Route | Page | Primary purpose |
|---|---|---|
| `/` | Home | Inspection history + create a session |
| `/inspection-rules` | Inspection Rules | Reference rule library; searchable and grouped |
| `/reports` | Reports | Completed/terminated dossiers |
| `/inspections/:id` | Session — Inspection / Live | Waiting, streaming, analysis, closed review |
| `/inspections/:id/rules` | Session — Applicable Rules | Rules selected for this specific asset/order + outcomes |
| `/inspections/:id/documents` | Session — Documents | Uploaded/pinned references, actual evidence, report artifacts |
| `/inspections/:id/dossier` | Session — Dossier | Frozen structured report on closure |

**Session tab labels:** Active state: **Live**, **Applicable Rules N**, **Documents N**. Closed state: **Inspection**, **Applicable Rules N**, **Documents N**, **Dossier**. Counts reflect persisted session data returned by the backend.

**Instruction sources:** The **Inspection Rules** library and each session's **Applicable Rules** and **Documents** provide access to indexed instruction sources. Preserve original document titles, rule numbers and section identifiers; allow each finding to open its version-pinned quoted source. No separate instruction-management module is required for the MVP.

## 3. Home: Inspection Sessions and Creation

**Home presentation:** Show the title “Autonomous Industrial Inspection” with the description “Live video, photographs and laser scans, checked against approved CAD and inspection rules.”

### 3.1 Inspection list (left)

- Title **Inspections**, search by name/session ID, filter tabs: **All**, **Active**, **Completed**, **Terminated**, each with a live count.
- Columns: **Inspection** (name + short ID), **Started**, **Session** (lifecycle state), **Outcome**, **Findings** (mini severity distribution, counts, unchecked/insufficient status), row navigation chevron.
- Sort newest first; list actual MongoDB sessions. Status values: `Waiting`, `Receiving`, `Analyzing`, `Ready to Close`, `Finalizing`, `Completed`, `Terminated`. Display user-facing grouping: the first five are **Active**.
- Outcome independent of lifecycle: `Pending`, `Pass`, `Warning`, `Fail`, `Inconclusive` (meaning defined in §10).
- Clicking an active item returns to its actual live session and current state; clicking a completed/terminated item opens a **read-only** session with history and dossier.
- Show only persisted sessions and computed status-filter counts; test data, when explicitly enabled, must never be confused with recorded inspections.

### 3.2 Start inspection (right)

- Heading **Start inspection**; required input **Inspection name** (example “CVS 6000D — Blue Valve Run”). **Start Inspection** disabled until a valid name exists.
- Optional **Customer specification or work order** upload accepts PDF, DOCX/Word and XLSX/Excel. In the hackathon demo the prepared work order (`WO-ARGUS-CVS48-001`, kept in the reference pack) is **uploaded through this control**; it is never applied silently. Without an upload, no order rules apply and the session says so. *(Updated 03 Nov 2026 by the project owner.)*
- **CAD model** selector from the CAD registry (each model declares equipment family, subtype and end connection); **Rules** summary says derived from valve type plus the uploaded document. The uploaded file adds only the rules it prints with an ID (e.g. `WO-R01`), quoted verbatim; it must **not** fabricate acceptance criteria from narrative text.
- Immediately create the session with a pinned baseline (CAD asset revision/hash, rule snapshot and source documents), then navigate to `/inspections/:id` with `Waiting for evidence`.
- Keep one reference pack as the MVP default; multiple asset types/reference packs are future scope. Show friendly error if the pack is unavailable.

## 4. Session — live / waiting / closed

### 4.1 Shell and actions

Top: “‹ Inspections” breadcrumb, name, lifecycle badge, `insp-...` session ID with copy icon, and **Upload Evidence**, **End Inspection**, **Terminate Now**. Buttons available **even while waiting**. Upload Evidence submits actual files to the same public ingestion endpoints used by Simulator (one or more MP4/JPG/PNG/PLY/PCD); file source is explicitly marked as manual rather than synthetic unless truly synthetic.

**Lifecycle:** `WAITING → RECEIVING ↔ ANALYZING → READY_TO_CLOSE → FINALIZING → COMPLETED` or **TERMINATED** from any open phase. A state may return to `RECEIVING` after prior work completes. The five labeled progress indicators in the right rail are a *stage summary*, not a claim that all are mutually exclusive. In the active-processing state, show “Receiving and analyzing” when both operate concurrently.

A sender's `source.complete` signals that **its upload schedule ended**, not that the inspection closed or all rules passed. `Ready to Close` means producer(s) finished and pending analysis is handled or explicitly enumerated; the **operator alone** triggers closing.

### 4.2 Evidence area (2×2 grid)

| Panel | Empty / waiting | During / after receipt |
|---|---|---|
| **Video** | “Awaiting camera”; source idle chip (`camera-01 idle`) | Play **actual** received MP4 or ordered segments with clip/capture time and source ID. Show segments as received, not fabricated video frames. While inference runs, playback continues. Historical replays remain available. |
| **Point cloud** | “Awaiting laser scan”; source idle | Incrementally append actual PLY/PCD **points**, using Three.js, with percentage and chunk count (“16 of 18”) separately labelled. Allow orbit/zoom, CAD overlay and validated registration stats. **Receiving 18 of 18 is not the same as 100% surface coverage.** |
| **Photographs** | Six labelled illustrative slots: Front flange, Bonnet, Body, Actuator, Other flange, Linkage | Populate thumbnails for actual received images, let users open full-resolution/crops, select and annotate. Layout supports any count; **6** is a scenario count, not a hardcoded limit. |
| **CAD reference** | Correct STEP-derived render present from first frame, filename label | Interactive orbit/zoom/pan; highlight actual mapped feature for selected evidence/rule/finding. Pin correct CAD revision and preserve transforms. If a feature cannot be mapped, do not draw a fictitious location marker. |

**Critical asset fidelity:** Every CAD view, actual or prepared video, photograph and point-cloud source for the scenario must represent the **same original 48-inch CVS 6000D air-cushioned swing check valve geometry**. Unrelated valve configurations or mechanically inconsistent imagery are invalid evidence. A renderer may simplify appearance but must preserve mechanical geometry and feature mapping. Never label an ungrounded representation with the canonical STEP filename.

### 4.3 Evidence timeline (bottom)

- Four timeline tracks: `camera-01`, `camera-photos-01`, `laser-01`, `analysis`.
- Marks represent actual received segment/photo/scan timing and real inspection events, with aligned relative time if their clocks share a defined epoch; otherwise show source-local timing with clear limitations.
- **Active**: current playhead, stream states and event markers (analysis in progress, pass/warning/fail observation). **Completed**: scrub/play through the frozen evidence chronology; video playback and point-cloud snapshot align where timestamps permit.
- Avoid treating model “analysis” time as if it were the original physical capture time. Show both when relevant.

### 4.4 Live inspection rail (right)

Top card: stage indicator `Waiting | Receiving | Analyzing | Ready to Close | Finalizing`, contextual status (e.g., “Waiting for evidence”, “Receiving and analyzing”, “Completed”), computed rule-progress bar and `N of M applicable rules evaluated`. For active runs show progress counters and *next actionable check* only when derivable from the selected rule checklist; never pretend a model predicted a fixed sequence.

Findings feed:

- Sticky heading **Live findings** and truthful counts (`N Pass`, `N Warning`, `N Fail`; optionally `N Inconclusive / Unchecked`).
- Stream **receipt / analyzing** activities distinct from final inspection results; e.g. “Position indicator — Evidence received; comparing with rule” is `Analyzing`, not a pass.
- Finding cards show state, feature/rule summary, timestamp, short evidence-based explanation, and expandable exact source quote/section/page, observation, media timestamp, CAD anchor *if validated*, scan measurements *if available*.
- Findings may be revised as new evidence arrives. Never silently overwrite prior reasoning: preserve finding versions and event audit.
- A result such as “Flange type matches the order” is permitted **only if** the pipeline confirmed the flange characteristic against the applicable reference, not merely from the session name or asset type.
- Prototype **“run simulated feed”** control is not shown in normal Argus. Optional developer-only fixture action must be hidden behind explicit dev mode, excluded from the hackathon production demo path and incapable of producing fake final findings.

### 4.5 Operators closing a session

| Action | Semantics | Dossier |
|---|---|---|
| **End Inspection** | Stop further intake, drain/wait on accepted analysis within a bounded timeout, record remaining incomplete checks; progress through `FINALIZING`. | Full dossier of all received evidence, results, and remaining uninspected rules; `COMPLETED`, outcome may still be `INCONCLUSIVE`. |
| **Terminate Now** | Stop intake and cancel pending work promptly; preserve processed evidence/events and mark pending/unsent evidence. | **Partial dossier** with `TERMINATED` status and `INCONCLUSIVE` overall outcome unless a verified failure is explicitly retained; never green Pass. |

Both actions ask for confirmation before irreversible closure, reject subsequent uploads (`409 SESSION_CLOSED`), freeze reference/rule snapshots and inspection event history, create dossier, link it on Home and Reports. The simulator receives closed-session responses and stops its sends.

### 4.6 Closed/read-only view

- Show session badge **Completed** or **Terminated**; evidence grid is a retained review player; timeline scrubber plays the actual retained media; past findings and counts are frozen.
- Right panel displays end time, feed duration, reference CAD, source specification and a **Dossier / Open Dossier** button. Show `Outcome: Warning` etc. distinctly from `Completed`.
- Do not let a closed session be mutated by incoming simulator activity or upload.

## 5. Session — Applicable Rules

Provide three successive rule-selection totals, a grouped table of applicable checks, and a **Why these rules** panel showing the selection rationale.

### 5.1 Selection cascade

1. **Rule library** — all indexed records from actual instruction sources (example dataset: **156**).
2. **Match valve type** — applicability filter for active asset type, end connection, configuration and CAD features (example dataset: **114**, not automatically all mandatory).
3. **Match customer specification** — inspection-specific subset: rules evaluable from session evidence, plus the rules printed in the uploaded customer document (example dataset: **10**). If no document is uploaded, no order rules apply and the panel says so.

These totals are computed from the indexed library and current inspection; **156 / 114 / 10** are example values, not required counts or proof that every source was extracted correctly. Each rule has an explainable selection reason and `APPROVED`, `DEMO_ONLY`, or `REFERENCE_ONLY` applicability. An LLM can propose candidates, but approval/filtering is deterministic or human-configured. No applicable numerical criterion may be inferred from a CAD shape alone.

### 5.2 Rule table

- Group by actual subject: Identification and Marking; Pressure-Boundary Castings and Forgings; Flanged Ends; Assembly, etc. Never show unrelated categories as applicable to this particular flanged check-valve assembly.
- Columns: real printed rule/section number, name, acceptance condition, necessary modality, evaluation state, expand action.
- Expand shows exact source document, quoted wording, page/section, applicable CAD feature, applicability rationale, observations, evidence IDs and missing prerequisites.
- Rule statuses: `NOT_INSPECTED`, `ANALYZING`, `PASS`, `WARNING/REVIEW_REQUIRED`, `FAIL`, `INSUFFICIENT_EVIDENCE`, `NOT_APPLICABLE`. `NOT_APPLICABLE` is excluded from the applicable-rule denominator and separately listed as filtered out.
- **Why these rules** panel explains model/configuration, end-connection proof, customer document, inclusion/exclusion, omitted valve end types and which checks require physical test records not received.
- Citation opening must use the **pinned** source version, not a later modified global document.

## 6. Session — Documents

Provide filter tabs `All`, `Reports`, `Specifications`, `Video`, `Photographs`, `Point clouds`, plus search and a downloadable file table containing filename, type, size and receipt time.

- Documents include **all** received media + the exact pinned CAD, applicable instruction/rule snapshot, work order/customer specification and generated dossier. Group categories and counts from stored assets, e.g. `50 evidence = 26 video segments + 6 photos + 18 point-cloud chunks`; if 3 pinned references and 1 dossier, `Documents 54` is a consistent example.
- File listing: filename, provenance/source, type, byte size, received time / source time, GCS-backed authorized download, archived hash. Use actual file sizes and filenames; never assume all MP4 segments are 8.2 MB.
- Support previews for compatible media and source files, and downloading original bytes. Do not imply a derived CAD GLB is the original STEP.
- Reference rules/CSV/other supporting records should be included if truly pinned for that session, and the Documents count should reflect them rather than hardcoded expected totals.
- Evidence is immutable upon closure; report artifact generated at closure is indexed as `Report`.

## 7. Global Inspection Rules

Provide searchable rule records, filters for **valve type** and **evidence type**, category groups with computed counts, section navigation and detailed rule rows. Supported top-level categories include `Visual Inspection`, `Identification`, `Assembly`, `Functional Testing`, `Release Gates` and `Global Rules`; actual source content determines which categories are present.

- Populate from the startup reference folder, with category hierarchy and computed counts from actual parsed/curated records.
- Show section/rule number, title, acceptance guidance, eligible evidence type, source name/page and optional scope/valve applicability.
- Search by title, ID, body, source; select top category and subordinate section; expand a row for full source excerpt and condition.
- **Reference-only** instructions remain browsable but are not counted as automatically evaluated checks; explain that some require test records (e.g., pressure tests) or inspection sensors not connected to the MVP.
- “ASME-based” is a source qualifier only when the indexed source truly supports it. Standards are never claimed to be fully implemented just because a checklist uses their names.
- A rule is indexed once in the library and can be selected into many sessions; changing a library file does not retroactively modify a completed inspection.

## 8. Global Reports and dossier

**Reports list:** Heading **Reports**; filters `All`, `Pass`, `Warning`, `Fail`, `Inconclusive`; searchable dossier entries with **name/ID, closed timestamp, Full/Partial, outcome, findings counts, View, Download**. List only actual completed/terminated sessions with successfully indexed report records; show generation error/retry when appropriate.

**Dossier view:** Readable report preview accessible from Reports and the closed-session tab, downloadable in **HTML** for MVP (PDF export optional). Includes:

1. Header with inspection name/ID and overall conclusion `PASS / WARNING / FAIL / INCONCLUSIVE`.
2. Lifecycle status (completed vs terminated), start/close timestamps, closure mode (full vs partial), pinned asset/CAD and order/spec identifiers.
3. Summary counters for applicable rules, pass, warning/review required, fail, insufficient/not inspected. Keep denominators coherent (e.g. 8 pass + 2 warning = 10 evaluated).
4. Each finding: actual rule ID + exact source citation, feature, method, evidence ID and link, relevant timestamp, observation, numeric scan measurement + uncertainty if available, confidence limitations and rationale.
5. Evidence completeness, scan registration/coverage quality, source-specific counts, any incomplete analysis, uninspected criteria and human-review disclaimer.
6. Frozen links/checksums and event/revision history; source files retained even if reports are regenerated from immutable data.

**Outcome aggregation:** verified `FAIL` dominates; otherwise any `WARNING/REVIEW_REQUIRED` → `WARNING` if no missing required checks; otherwise required `NOT_INSPECTED/INSUFFICIENT_EVIDENCE` → `INCONCLUSIVE`; `PASS` only when **all required applicable rules are supported passes**. For a partial termination, default `INCONCLUSIVE`, while separately highlighting any verified failed rule. Physical release or certification is never automatic.

## 9. Evidence-driven agentic inspection behavior

One **bounded inspection coordinator** (not a fleet of invented agents) acts on meaningful evidence events. It calls specialized tools but never accesses Simulator's private ground truth.

```text
Operator starts named inspection
  └─ Pin CAD + work order + source documents + applicable rule snapshot
Simulator or real producer sends MP4/JPG/PLY bytes to public ingestion APIs
  ├─ Immediate (fast path): validate/hash/store; event; update video/photo/point-cloud UI
  └─ Async analysis path:
       classify evidence and infer candidate CAD feature + applicable existing rule
       ├─ Meta Muse Spark visual analysis on actual photo/video/frame + rule context
       ├─ Meta SAM 3.1 segmentation/tracking when component localization helps
       └─ Python CAD/point-cloud tool (registration, coverage, measurement & residuals)
       correlate observations on feature/time/coordinate provenance
       deterministic rule evaluator + evidence sufficiency and precision gate
       store observation/finding revision; publish SSE -> live feed and CAD highlight
Operator ends or terminates -> final dossier -> Reports / Home history
```

**Technologies:** React/TypeScript/Vite/Tailwind; React Three Fiber/Three.js for CAD and incremental point clouds; Node.js/TypeScript/Fastify for HTTP, MongoDB, GCS, ingestion and SSE; Python/FastAPI/OpenCV/Open3D/NumPy/SciPy and OCP/Open Cascade preprocessing for geometric tools; Meta Model API with Muse Spark series and SAM 3.1 for visual reasoning/segmentation. MongoDB Atlas persists sessions/events/findings; Google Cloud Storage retains original and derived media. A bounded task queue decouples network upload from AI processing. No acoustic model or sound-processing branch.

**Inspection gates:**

- A photo of a fine flange indication may trigger **WARNING / review** with crop and exact rule, but does not prove crack depth or cause a pressure-boundary FAIL without qualifying evidence.
- An empty pipe-connection flange bolt hole is not a missing assembled bonnet fastener.
- A numerical mm alignment or flatness finding needs known units, scan calibration/registration, quality and an actual approved tolerance. Display `INSUFFICIENT_EVIDENCE` when these are missing.
- No scan evidence of surface geometry deformation does **not** invalidate a suspected tiny surface crack in the camera photo.
- A finding's CAD coordinate requires a verified feature mapping or transform. No decorative highlights at invented coordinates.
- For “no visible cracks”, record **inspected-region coverage and detection limits**; only mark PASS for the specific bounded rule/region when the evidence suffices, not for the entire valve.
- Model outputs must be structured, source-linked observations, **not pre-supplied desired PASS/FAIL results**. Keep model call identifiers and failure reasons in audit history.

## 10. Lifecycle, data model, API and events

### 10.1 Explicit field separation

- `lifecycleStatus`: `WAITING | RECEIVING | ANALYZING | READY_TO_CLOSE | FINALIZING | COMPLETED | TERMINATED`.
- `outcome`: `PENDING | PASS | WARNING | FAIL | INCONCLUSIVE`. Display independently.
- `ruleStatus`: `NOT_INSPECTED | ANALYZING | PASS | WARNING | FAIL | INSUFFICIENT_EVIDENCE | NOT_APPLICABLE`.
- `deliveryStatus`: `SCHEDULED | SENDING | ACCEPTED | FAILED | NOT_SENT` (sender-specific; never shown as inference result).
- `coverage`: media type, target feature, inspected region, scan coverage percentage, sensor/registration confidence, source count and valid transforms; completeness separate from status.

### 10.2 Essential MongoDB collections

`inspections` (name, asset type, reference pack/hash, timestamps, lifecycle, outcome, counts, closure mode); `ruleLibrary` or offline index (real source and category); `referenceSnapshots` (version-pinned rules/CAD/documents); `evidence` (GCS key/hash, media, source, sequence, timing, processing, pose/units); `observations`; `findings` and revisions; `events` (monotonic sequence); `dossiers` (HTML GCS URI and summary). Index by session ID and idempotency `(sessionId,eventId)`.

### 10.3 Public API v1 (both repos must implement exactly this contract)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/inspections` | Create name + reference-pinned session; optional order upload via multipart or staged file |
| `GET` | `/api/v1/inspections` | Home searchable/filterable sessions; accurate counts |
| `GET` | `/api/v1/inspections/:id` | Session state, source/analysis progress and reference identifiers |
| `GET` | `/api/v1/inspections/:id/events` | Server-Sent Events with reconnect (`Last-Event-ID`) |
| `POST` | `/api/v1/inspections/:id/video` | Real MP4 full recording or ordered MP4 chunk |
| `POST` | `/api/v1/inspections/:id/photos` | JPEG/PNG image |
| `POST` | `/api/v1/inspections/:id/pointcloud` | PLY/PCD geometry chunk |
| `POST` | `/api/v1/inspections/:id/complete` | Sender ends its schedule; Argus session remains open |
| `POST` | `/api/v1/inspections/:id/close` | End Inspection; drain, finalize and dossier |
| `POST` | `/api/v1/inspections/:id/terminate` | Immediate stop; frozen partial dossier |
| `GET` | `/api/v1/inspections/:id/evidence` | Documents/evidence listing and authorized media download |
| `GET` | `/api/v1/inspections/:id/findings` | Inspection activity, outcomes and revisions |
| `GET` | `/api/v1/inspections/:id/rules` | Applicable rules; selection hierarchy + why selected |
| `GET` | `/api/v1/inspections/:id/documents` | Reference + evidence + dossier indexed assets |
| `GET` | `/api/v1/inspections/:id/dossier` | Report HTML, summary and downloadable link after closure |
| `GET` | `/api/v1/instruction-sets` | Global rule sources and versioned indexed rules for Rules page |
| `GET` | `/api/v1/reports` | Filter/search actual finalized report records |

**Upload format:** `multipart/form-data`, `file` containing actual bytes and `metadata` JSON including `schemaVersion:"1.0"`, `eventId`, `sourceId`, per-source `sequence`, `relativeTimeMs` or `capturedAt`, `mediaType`, `synthetic` (provenance). Scans additionally require `units`, `coordinateFrame` and optional `pose`. Names/hints are **not** findings. Respond `202 { evidenceId, accepted:true, processingStatus:"queued" }` only after bytes are accepted/stored. Model analysis is asynchronous. `400/404/409/413/415/429/5xx` semantics as in v0.7. Retry `429/5xx` with identical event ID, no retry after session closes.

**SSE:** `inspection.created`, `evidence.received`, `evidence.processing`, `source.state`, `observation.created`, `finding.created`, `finding.updated`, `rule.progress`, `coverage.updated`, `source.complete`, `inspection.finalizing`, `inspection.closed`, `dossier.ready`, `inspection.error`. Include `sessionId`, monotonic event sequence, timestamps, evidence IDs and rule/feature refs when available. On reconnect fetch current snapshot and resume, never replay placeholder findings.

**Direct upload parity:** manual uploads use the **same** ingestion handlers; `synthetic` flag must reflect the actual source, not falsely assign every upload synthetic. Original full MP4 is allowed; live RTSP/WebRTC hardware stream is future scope.

### 10.4 Security and availability

No login **UI** for private hackathon demo. Protect externally reachable ingestion endpoints with server-to-server token or network restrictions and rate/size limits; keep Meta/GCS credentials off the browser and simulator repository. Provide useful empty/error states when no MongoDB/GCS/model connection is available.

## 11. Reference data and file structure

```text
src/cad_models.json            # CAD registry: model_id, family, type, end_connection, sha256
src/inspection_rules/*.md      # rule source documents
src/reference-data/
  rule-library.json            # generated, content-versioned rule index
  rule-metadata.json           # stage, evidence type, equipment applicability, approved thresholds
  visual-routing.json          # SAM component -> rule routing per equipment family
  cvs6000d-48-demo/
    cad/cad_reference.ply      # reference cloud derived from the registered CAD
    customer-documents/        # demo work order, uploaded through the UI
```
*(Updated 03 Nov 2026 to the implemented layout; the earlier STEP/GLB/features.json plan remains future work.)*

A customer upload adds a **session-scoped source document** and an applicability decision; the rule library does not assume its terms are a new universal standard. Each rule has stable rule ID, source file/page/printed section, exact quote, category, feature(s), evidence modalities, applicability, numerical threshold *only when approved*, and selection reason.

## 12. Feature Acceptance Criteria

- [ ] Home accurately shows session name, start date, lifecycle, outcome, per-state filters/counts, search and a working creation panel; history survives restart.
- [ ] Optional order upload parses/stores actual document and identifies applied rule snapshot; no upload required for default scenario.
- [ ] Session starts **Waiting** with exact STEP-derived CAD and empty video/photo/laser panes; copy ID works; End/Terminate available immediately.
- [ ] Simulator/media uploads update video and photo panels at receipt; point cloud visually accumulates **actual points** and distinguishes received chunks from coverage percentage.
- [ ] Real timeline aligns receipt/capture events and analysis events; no fake model result events.
- [ ] Right rail shows five stages and evidence/rule progress without conflating lifecycle and quality outcome; the finding feed updates as actual analysis finishes.
- [ ] A real Meta visual observation is linked to actual received image/clip and source rule; SAM segmentation assists at least one component localization; Python computes at least one defensible CAD-to-scan metric with quality metadata.
- [ ] Global Inspection Rules shows dynamically indexed counts, categories, search/filters and exact source excerpts; session Applicable Rules shows rule selection cascade and **Why these rules**.
- [ ] Documents list contains real media, references, sizes, timestamps, sources and actual downloads; totals reconcile with uploaded assets.
- [ ] End Inspection creates full dossier and Completed session; Terminate Now creates partial dossier and Terminated session; both stop future uploads.
- [ ] Reports filters, View, Download and dossier preview work for persisted sessions; closed-session evidence plays read-only.
- [ ] The displayed valve/photographs/video/scans physically match the original CVS STEP assembly, not a generic diaphragm actuator graphic.
- [ ] No acoustic agent, simulation action in production Argus, forced false passes, fabricated citations, login or extra hardware subsystem.

### Hackathon walkthrough

Home with history → Inspection Rules library → Start Inspection with name (optional spec) → see CAD and waiting panes → open independent Simulator and press **Send Simulated Data** → evidence thumbnails/video/point cloud/timeline populate → model/rule findings arrive live → open one rule, its proof and CAD location → End Inspection → dossier → Reports/Home reopen. Optional second demo: Terminate Now midstream and show partial, inconclusive dossier.

 