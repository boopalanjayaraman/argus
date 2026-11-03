# PRD-12 — Inspections Grouped by Work Order, and Previous Inspections (Argus)

Status: Implemented (04 Nov 2026, user request) · **Display only** · Source: Spec §1 (continuous, multi-stage inspection) · Depends on: PRD-03 (order document), PRD-06 (pinned snapshot)

## Problem

Continuous inspection means the same equipment is inspected several times as it is built. Until now every inspection stood alone: nothing showed that "during build" and "finished" were the same valve, or how a rule changed from one stage to the next.

## Specs

- **Grouping key:** the work order number read from the uploaded order document, plus the asset ID the document prints (assembly identifier, serial, tag or asset number) when present — e.g. `WO-ARGUS-CVS48-001 / CVS48-AC-DEMO-002`. One work order can cover several units, hence the asset ID. Inspections without an uploaded order, or whose order number could not be read, are not grouped.
- **Home:** inspections sharing a key are listed together under a header row (`Work order … · N inspections of the same equipment, in stage order`), oldest first, each labelled `Stage n`; groups sit where their newest inspection would. Ungrouped inspections are unchanged; a grouped inspection on its own shows its key under its name.
- **Inspection page:** a **Previous Inspections N** tab appears only when earlier inspections share the key. It shows (1) the earlier inspections and this one in stage order with CAD model name, start time, lifecycle, outcome and *Open*; (2) **Rule results across stages** — every rule of this inspection that has a result in an earlier one, with its status per stage. A note states that earlier results are for reference only.
- **Display only:** earlier results never change this inspection's findings, outcome or dossier. Only inspections created **before** this one are "previous". Inspections created before this feature are grouped too (the key comes from their pinned snapshot's order document).

Out of scope: manual linking or unlinking, carrying an open issue forward as a tracked item, CAD per stage, stage-dependent rule applicability (roadmap).

## Technical Specs

- `assetIdFrom(text)` and `groupKeyOf(order, asset)` in `src/apps/api/src/server.ts`; the asset ID is read from the stored extraction text of the order document.
- `GET /api/v1/inspections` adds `orderNumber`, `assetId`, `groupKey`, `stageLabel` per inspection.
- `GET /api/v1/inspections/:id/history` → `{orderNumber, assetId, groupKey, previous[{id, name, stageLabel, createdAt, closedAt, lifecycleStatus, outcome, findings}], rules[{ruleId, code, title, current, previous[{sessionId, status, reason}]}]}`; `status: NOT_IN_SCOPE` when the earlier inspection's snapshot did not contain the rule.
- Web: `homeGroups` in `App.tsx`; tab `Previous Inspections`; deep link `#session/<id>/previous`. Existing design classes only.

## Acceptance

- [x] Two inspections created with the same work order are grouped; a third without an order is not.
- [x] The later inspection lists the earlier one as previous; the earlier one never lists the later one.
- [x] Live data: four inspections with `WO-ARGUS-CVS48-001` grouped as Stage 1–4; 43 rules compared across stages.

## Test Plan

- Vitest: asset-ID extraction and key building; grouping and history ordering through the API with the mock orchestrator.

## Review gate

Approved by the user on 04 Nov 2026 ("from the work order upload, extract and map that it is the same, group them in the grid in home page, and … a tab to include findings from the past inspection"). Edit this file to change scope.
