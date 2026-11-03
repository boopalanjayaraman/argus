# PRD-05 — Live Session: SSE & Viewers (Argus)

Status: Implemented (v2, 03 Nov 2026: web consumes SSE with Last-Event-ID resume; polling replaced) · Source: Spec §4 · Tech Stack §§5,7 · Depends on: PRD-04

## Specs

- Session shell: breadcrumb, name, lifecycle badge, copyable `insp-...` ID, **Upload Evidence / End Inspection / Terminate Now** available even while Waiting (actions wired in PRD-08; here: present + Upload works via PRD-04).
- 2×2 grid: **Video** (actual MP4/segments, source + capture time), **Point cloud** (Three.js incremental points, “N of M chunks” separate from coverage %), **Photographs** (real thumbnails, full view; 6 slots illustrative, any count works), **CAD reference** (orbit/zoom/pan GLB from first frame; highlight only validated feature mappings).
- Timeline: 4 tracks (`camera-01`, `camera-photos-01`, `laser-01`, `analysis`); receipt vs analysis time kept distinct. Right rail: 5-stage indicator (Waiting/Receiving/Analyzing/Ready to Close/Finalizing — Receiving+Analyzing may overlap), rule progress `N of M`, Live findings feed (receipt/analyzing activity never shown as a verdict).
- Lifecycle: `WAITING → RECEIVING ↔ ANALYZING → READY_TO_CLOSE → FINALIZING → COMPLETED|TERMINATED`. No “run simulated feed” control in Argus.

Out of scope: finding generation (PRD-07), dossier (PRD-08).

## Technical Specs

- **Pattern:** SSE `GET /api/v1/inspections/:id/events` — events persisted in Mongo `events` with monotonic `eventSeq` **before** publish; types: `inspection.created, evidence.received/processing, source.state, observation.created, finding.created/updated, rule.progress, coverage.updated, source.complete, inspection.finalizing/closed, dossier.ready, inspection.error`.
- **Reconnect pattern:** the browser `EventSource` resends `Last-Event-ID` automatically; the server replays only events with `eventSeq` greater than it (header or `?lastEventId=`), sends `retry: 2000` and a heartbeat comment every `SSE_HEARTBEAT_MS`. The web app refetches the session snapshot (session, evidence, rules, documents) on each event, debounced 200 ms, plus a 15 s reconciliation poll in case SSE is blocked by a proxy. Events are unnamed SSE messages; the type is in the payload. A closed (Completed/Terminated) session opens no stream — it is frozen — and keeps only the reconciliation poll. Playback/point rendering never blocks on inference.
- **Additional events (v2):** `source.state` on every lifecycle change, `observation.created` for SAM segmentations, `inspection.snapshot` when an order document re-pins the snapshot.
- **3D:** React Three Fiber + Drei; point chunks appended by `evidenceId` (dedupe on replay); CAD highlight only when `cadAnchor` validated, else image-region highlight only.
- **Configuration:** `SSE_HEARTBEAT_MS` (default 15000), signed-URL TTL for media.

## Acceptance

- [ ] Simulator send populates all panes + timeline in real time; reconnect mid-stream reconciles without duplicates.
- [ ] Chunk count and coverage never conflated; empty states truthful.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §4 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §§5,7 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §3
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) session artboard (2×2 grid, timeline, right rail) + `bundle.css`; replicate values, don't ship markup.

## Test Plan (write before implementation — tests fail first)

- Unit: event reducer dedupes by `evidenceId/eventSeq`; chunk count ≠ coverage in view model; unvalidated `cadAnchor` renders no CAD marker.
- Contract: SSE emits persisted events in monotonic order; `Last-Event-ID` reconnect + snapshot refetch yields no duplicates/placeholders.
- UI (RTL/Playwright): Waiting empties truthful; receipt updates video/photo/point panes before inference; receipt activity never rendered as verdict; no “run simulated feed” control.
- Negative: SSE drop mid-stream recovers; closed session renders read-only.

## Verification (after implementation)

- [ ] Run this PRD's full test list + Acceptance above.
- [ ] Playwright with Simulator: send → panes/timeline populate; kill/reconnect SSE mid-stream. No test red/skipped.

## Review gate

v2 (SSE in the web app) implemented on the user's go-ahead of 03 Nov 2026 (issue #14). Edit this file to change scope.
