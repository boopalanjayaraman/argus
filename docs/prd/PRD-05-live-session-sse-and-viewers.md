# PRD-05 — Live Session: SSE & Viewers (Argus)

Status: Awaiting review · Source: Spec §4 · Tech Stack §§5,7 · Depends on: PRD-04

## Specs

- Session shell: breadcrumb, name, lifecycle badge, copyable `insp-...` ID, **Upload Evidence / End Inspection / Terminate Now** available even while Waiting (actions wired in PRD-08; here: present + Upload works via PRD-04).
- 2×2 grid: **Video** (actual MP4/segments, source + capture time), **Point cloud** (Three.js incremental points, “N of M chunks” separate from coverage %), **Photographs** (real thumbnails, full view; 6 slots illustrative, any count works), **CAD reference** (orbit/zoom/pan GLB from first frame; highlight only validated feature mappings).
- Timeline: 4 tracks (`camera-01`, `camera-photos-01`, `laser-01`, `analysis`); receipt vs analysis time kept distinct. Right rail: 5-stage indicator (Waiting/Receiving/Analyzing/Ready to Close/Finalizing — Receiving+Analyzing may overlap), rule progress `N of M`, Live findings feed (receipt/analyzing activity never shown as a verdict).
- Lifecycle: `WAITING → RECEIVING ↔ ANALYZING → READY_TO_CLOSE → FINALIZING → COMPLETED|TERMINATED`. No “run simulated feed” control in Argus.

Out of scope: finding generation (PRD-07), dossier (PRD-08).

## Technical Specs

- **Pattern:** SSE `GET /api/v1/inspections/:id/events` — events persisted in Mongo `events` with monotonic `eventSeq` **before** publish; types: `inspection.created, evidence.received/processing, source.state, observation.created, finding.created/updated, rule.progress, coverage.updated, source.complete, inspection.finalizing/closed, dossier.ready, inspection.error`.
- **Reconnect pattern:** client sends `Last-Event-ID`; on reconnect refetch session snapshot then resume stream — never replay placeholder findings. Playback/point rendering never blocks on inference.
- **3D:** React Three Fiber + Drei; point chunks appended by `evidenceId` (dedupe on replay); CAD highlight only when `cadAnchor` validated, else image-region highlight only.
- **Configuration:** `SSE_HEARTBEAT_MS` (default 15000), signed-URL TTL for media.

## Acceptance

- [ ] Simulator send populates all panes + timeline in real time; reconnect mid-stream reconciles without duplicates.
- [ ] Chunk count and coverage never conflated; empty states truthful.

## Review gate

Reply `go PRD-05` to implement, or edit this file first.
