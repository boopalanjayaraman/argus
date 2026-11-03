# PRD-06 — Applicable Rules & Documents (Argus)

Status: Implemented (v2, 03 Nov 2026: real three-step cascade from the pinned snapshot; Documents list the snapshot and order document) · Source: Spec §§5–6 · Depends on: PRD-02, PRD-03, PRD-05

## Specs

- Session tabs: active `Live · Applicable Rules N · Documents N`; closed adds `Dossier`. `N` = rules evaluable in this session; counts from backend, never hardcoded.
- Applicable Rules — **selection cascade, each step a real filter over the pinned snapshot:**
  1. **Rule library** — all indexed rules (161 at library revision `50c8aa500dae84af`).
  2. **Match valve type** — rules whose equipment metadata matches the pinned CAD model's family, subtype and end connection (CVS 6000D: Valve / swing check / flanged → 153; the 8 butt-weld and threaded-end rules drop out).
  3. **Match customer specification** — of those, the rules Argus can evaluate from session evidence (photos, video, laser scan), **plus** the rules printed in an uploaded order document (CVS 6000D: 64 without an order; +6 with the demo work order). The sub-label names the order or says none was uploaded.
- Grouped rule table (rule number, name, acceptance text, modality, state); expand shows the pinned quote and citation (document · section · rule, page for order rules), the finding's reason and evidence. Statuses: `NOT_INSPECTED, ANALYZING, PASS, WARNING, FAIL, INSUFFICIENT_EVIDENCE, NOT_APPLICABLE` (record-only rules; excluded from the denominator).
- **Why these rules** panel: valve type with family/subtype, end connection from the CAD registry, the order document (number, rules read or extraction failure), the snapshot ID and library revision, the server's selection explanation, and what was left out (record-only rules, other valve types/ends, order rules when no document). While `WAITING` the panel accepts an order document (PRD-03).
- Documents: filter tabs All/Reports/Specifications/Video/Photographs/Point clouds + search; table filename, source, type, byte size, receipt time, hash, download. **Specifications** = pinned CAD baseline, **rule snapshot** (`rule-snapshot-<sessionId>.json`, the exact pinned rules), and the uploaded order document; Reports = dossier once generated. Every row downloads its bytes. Totals reconcile.

Out of scope: live rule evaluation (PRD-07), dossier generation (PRD-08).

## Technical Specs

- **Pattern:** deterministic selector `selectSessionRules(index, model, orderDocument)` in `src/apps/api/src/rules.ts`; result frozen in the session's `referenceSnapshots` record. Every later read — rules tab, analysis requests to the inspection service, dossier, reports — uses the snapshot, never the live library.
- **API:** `GET /api/v1/inspections/:id/rules` → `{cascade{library,valveType,customerSpec,orderRules,referenceOnly,filteredOut}, rules[], snapshot{snapshotId,revision,sha256,libraryRevision}, model, orderDocument, why}`; `GET .../documents` (each pinned row has `docId` + `url`); `GET .../documents/:docId/file` (`cad`, `rule-snapshot`, order document id, `dossier`).
- **Citation integrity:** citations resolve to the snapshot's copy of each rule.

## Acceptance

- [x] Cascade counts computed from the index and the pinned model; step 2 < step 1 and step 3 < step 2 without an order; order rules add to step 3.
- [x] Documents list the rule snapshot (downloadable JSON), not the removed `rules.json`.
- [ ] Manual: change a library rule, reopen a closed session — pinned quote unchanged.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §§5–6 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §6 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §§4,8
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) Applicable Rules/Documents tabs + `bundle.css`; replicate values, don't ship markup.

## Test Plan

- Unit (Vitest): cascade steps strictly narrow; order rules add only evaluable ones; snapshot unaffected by an injected library rule; snapshot document downloads and parses.
- UI: tab counts from API; funnel sub-labels show equipment and order; Why panel lists snapshot ID.

## Verification

- [x] API suite green (cascade, pinning, documents).
- [ ] Headless screenshot of the Applicable Rules tab with and without the demo work order.

## Review gate

Implemented on the user's go-ahead of 03 Nov 2026 (issues #3, #4, #5). Edit this file to change scope.
