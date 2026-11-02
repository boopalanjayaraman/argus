# PRD-04 — Evidence Ingestion API (Argus)

Status: Awaiting review · Source: Spec §10.3 · Tech Stack §5 · Depends on: PRD-01, PRD-03 · **Contract twin: Simulator PRD-S03 must match this exactly.**

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

## Review gate

Reply `go PRD-04` to implement, or edit this file first.
