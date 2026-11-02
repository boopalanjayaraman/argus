# Argus — PRDs

One feature at a time. **Review a PRD, edit it here if needed, then say `go PRD-XX` before any implementation.** No PRD is implemented without your go-ahead.

| # | PRD | Depends on | Status |
|---|---|---|---|
| 01 | [Foundation scaffolding](PRD-01-foundation-scaffolding.md) | — | Awaiting review |
| 02 | [Reference pack & rule library](PRD-02-reference-pack-and-rule-library.md) | 01 | Awaiting review |
| 03 | [Home & session creation](PRD-03-home-and-session-creation.md) | 01, 02 | Awaiting review |
| 04 | [Evidence ingestion API](PRD-04-evidence-ingestion-api.md) | 01, 03 | Awaiting review |
| 05 | [Live session: SSE & viewers](PRD-05-live-session-sse-and-viewers.md) | 04 | Awaiting review |
| 06 | [Applicable Rules & Documents](PRD-06-applicable-rules-and-documents.md) | 02, 03, 05 | Awaiting review |
| 07 | [Inspection coordinator (AI/geometry)](PRD-07-inspection-coordinator.md) | 04, 06 | Awaiting review |
| 08 | [Closure, dossier & Reports](PRD-08-closure-dossier-and-reports.md) | 05, 06, 07 | Awaiting review |

Each PRD has: **Specs** (functional, from `Argus_Spec.md` v0.9) and a separate **Technical Specs** section (design patterns, retry, configuration, data/API contracts). Sources: [spec](../specs/Argus_Spec.md) · [tech stack](../architecture/Argus_Tech_Stack.md) · [agentic architecture](../architecture/Argus_Agentic_Architecture.md) · [UX mockup](../ux/Argus%20click-through-html/Main.dc.html).
