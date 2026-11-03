# Argus — PRDs

One feature at a time. **Review a PRD, edit it here if needed, then say `go PRD-XX` before any implementation.** No PRD is implemented without your go-ahead.

| # | PRD | Depends on | Status |
|---|---|---|---|
| 01 | [Foundation scaffolding](PRD-01-foundation-scaffolding.md) | — | Implemented |
| 02 | [Reference pack & rule library](PRD-02-reference-pack-and-rule-library.md) | 01 | Implemented v2 (indexed library, equipment metadata) |
| 03 | [Home & session creation](PRD-03-home-and-session-creation.md) | 01, 02 | Implemented v2 (pinned snapshot, order document upload) |
| 04 | [Evidence ingestion API](PRD-04-evidence-ingestion-api.md) | 01, 03 | Implemented |
| 05 | [Live session: SSE & viewers](PRD-05-live-session-sse-and-viewers.md) | 04 | Implemented v2 (web consumes SSE) |
| 06 | [Applicable Rules & Documents](PRD-06-applicable-rules-and-documents.md) | 02, 03, 05 | Implemented v2 (real cascade, snapshot documents) |
| 07 | [Inspection coordinator (AI/geometry)](PRD-07-inspection-coordinator.md) | 04, 06 | Implemented v2 (live queue, SAM masks, scan rules) |
| 08 | [Closure, dossier & Reports](PRD-08-closure-dossier-and-reports.md) | 05, 06, 07 | Implemented v2 (drain/cancel, dossier citations) |
| 09 | [Evidence viewer dialog](PRD-09-evidence-viewer-dialog.md) | 04, 05 | Implemented |
| 10 | [SAM component routing](PRD-10-sam-component-routing.md) | 06, 07 | Implemented (PRD written after the change, approved 2026-11-03) |
| 11 | [Analyzed video: tracked parts & possible issues](PRD-11-analyzed-video-annotations.md) | 07, 09, 10 | Implemented (display only, 2026-11-03) |

Each PRD has: **Specs** (functional, from `Argus_Spec.md` v0.9) and a separate **Technical Specs** section (design patterns, retry, configuration, data/API contracts). Sources: [spec](../specs/Argus_Spec.md) · [tech stack](../architecture/Argus_Tech_Stack.md) · [agentic architecture](../architecture/Argus_Agentic_Architecture.md) · [UX mockup](../ux/Argus%20click-through-html/Main.dc.html).
