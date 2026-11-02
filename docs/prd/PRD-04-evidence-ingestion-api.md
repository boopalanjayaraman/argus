# PRD-04 — Evidence Ingestion API (Argus)

Status: Implemented (v1: Fastify+React, local file storage; Mongo/GCS/Meta adapters pending) · Source: Spec §10.3 · Tech Stack §5 · Depends on: PRD-01, PRD-03 · **Contract twin: Simulator PRD-S03 must match this exactly.**

## Specs

- Endpoints: `POST /api/v1/inspections/:id/video|photos|pointcloud`, `POST .../complete` (sender finished; session stays open), `GET /api/v1/inspections/:id`, `GET .../evidence`. Manual **Upload Evidence** uses the same handlers (`synthetic` reflects true provenance).
- Upload: `multipart/form-data`, `file` = real bytes, `metadata` JSON `{ schemaVersion:"1.0", eventId, sourceId, sequence, relativeTimeMs|capturedAt, mediaType, synthetic }`; point clouds also require `units`, `coordinateFrame`, optional provenanced `pose`. Full-length MP4 allowed.
- Reply `202 { evidenceId, accepted:true, processingStatus:"queued" }` **only after** bytes stored (GCS) + hashed + evidence record/event committed. `202` ≠ analyzed ≠ PASS.
- Errors: `400` bad metadata, `404` unknown session, `409 SESSION_CLOSED` after close/terminate, `413` too large, `415` wrong media type. Closed sessions never return `202`.

Out of scope: inference (PRD-07), SSE fan-out details (PRD-05).

## Technical Specs

- **Idempotency pattern:** unique index `(sessionId, eventId)`; repeat with identical payload returns original acceptance; same ID with conflicting payload → `409`. This is what makes Simulator retries safe.
- **Retry contract (server side):** `429/5xx` are retryable by sender with same `eventId`; `400/404/409/413/415` terminal. Rate/size limits via Fastify plugins; ingestion token (`ARGUS_INGEST_TOKEN`, server-to-server) when externally exposed — never in browser/simulator bundles as a login.
- **Storage pattern:** fast path only — validate → hash → GCS put → Mongo `evidence`+`events` insert → enqueue bounded analysis job → `202`. No model call in request path. Originals immutable; derived artifacts are new objects.
- **Configuration:** `MAX_VIDEO_MB / MAX_PHOTO_MB / MAX_POINTCLOUD_MB`, `GCS_BUCKET`, `MONGODB_URI` (env only).

## Acceptance

- [ ] Curl/Simulator sends real MP4/JPG/PLY; evidence listed with real size/hash/source.
- [ ] Duplicate `eventId` does not duplicate evidence; post-close upload gets `409`.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §10.3 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §5 · Contract twin: Simulator PRD-S03
- UX: none (API-only); evidence surfaces checked in PRD-05 against [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html).

## Test Plan (write before implementation — tests fail first)

- Contract (per endpoint video/photos/pointcloud): valid multipart → `202 {evidenceId,accepted,processingStatus:queued}` after store+hash; evidence listed with real size/hash.
- Idempotency: same `(sessionId,eventId)`+payload → original `202`, one record; same ID conflicting payload → `409`.
- Negative: bad metadata `400`, unknown session `404`, closed session `409 SESSION_CLOSED` (never `202`), oversize `413`, wrong type `415`; pointcloud without `units/coordinateFrame` → `400`.
- Ordering: `202` only after bytes retrievable; manual upload keeps true `synthetic` provenance.

## Verification (after implementation)

- [ ] Run this PRD's full test list + Acceptance above; repeat suite against Simulator PRD-S03 mock contract.
- [ ] Manual curl with real MP4/PNG/PLY from `simulated_data/`. No test red/skipped.

## Review gate

Reply `go PRD-04` to implement, or edit this file first.
