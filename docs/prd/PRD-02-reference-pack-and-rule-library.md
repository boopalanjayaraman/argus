# PRD-02 — Reference Pack & Rule Library (Argus)

Status: Implemented (v2, 03 Nov 2026: indexed library + equipment metadata; demo 5-rule pack removed) · Source: Spec §§5,7,11 · Tech Stack §6 · Depends on: PRD-01

## Specs

- Reference pack `src/reference-data/cvs6000d-48-demo/`: `cad/` (generated CAD reference cloud `cad_reference.ply` + hash metadata, derived from the registered CAD) and `customer-documents/` (the demo work order `Argus_CVS6000D_48in_Work_Order.pdf`, uploaded through the UI in the demo, never auto-applied). The former 5-rule demo pack (`rules/rules.json`, `GET /api/v1/rule-pack`) is removed; the indexed library below is the only rule source.
- All media/CAD depict the same 48″ CVS 6000D assembly; derived meshes/clouds are never labelled as the original CAD.
- **CAD registry (decided):** `src/cad_models.json` is the CAD list source. Each entry: `model_id` (opaque connector, e.g. `CVS6000_VALVE`), `display_name`, `revision`, **`family`** (e.g. `Valve`), **`type`** (valve subtype, e.g. `swing_check`), **`end_connection`** (e.g. `flanged`), `reference_pack`, `cad_file` (forward-slash path relative to `src/`), `cad_format`, `sha256`. `model_id` is the join key with the Simulator's `available_simulations.json` — never a filesystem path supplied by a client. Two models may share one CAD (`CVS6000_VALVE`, `CVS3000_VALVE`: same STL, different evidence scenario).
- **Rule library:** rule documents in `src/inspection_rules/*.md` are indexed once into `src/reference-data/rule-library.json` by `npm run index:rules` (`src/apps/api/src/rules.ts`). Runtime reads only the index. A test fails when the committed index is stale.
- **Rule metadata (decided):** `src/reference-data/rule-metadata.json` gives each document its library stage and evidence type, and each rule its **equipment applicability** `{family, types, endConnections}`. For the demo all rule documents are treated as **one manufacturer's rule set**: product-series documents (3241, 2392, …) apply to every valve. Narrowing comes only from a rule's own text (2.6 flow arrow: globe/check/unidirectional; 8.4 disc swing: check valves; 4.x flanged, 5.x butt-weld, 6.x threaded/socket-weld ends).
- **Approved scan thresholds:** numeric thresholds exist only in metadata with an approval record (`approval: {by, on, scope}`), currently the DEMO_ONLY scan rules GEO-001…003 from `inspection_09_cad_scan_conformance.md` (approved by the project owner on 03 Nov 2026 for the hackathon demo).
- Global Inspection Rules page `/inspection-rules`: searchable (title/ID/body/source), evidence-type filter, stage groups with **computed** counts (161 rules, 19 documents at index revision `50c8aa500dae84af`), expand for full excerpt. Reference-only rules browsable, never counted as auto-evaluated.

Out of scope: session rule selection (PRD-06), any tolerance inferred from CAD shape or proposed by a model.

## Technical Specs

- **Pattern:** offline indexer parses sources + metadata into a versioned index; runtime only reads it (mtime-cached). Revision = hash(source hashes, metadata hash, `INDEXER_VERSION`), so the same inputs always give the same revision. No timestamps in the index.
- **Data:** rule record = `{ ruleId, code, title, text/quote, line, reference, note, document, source, sourceSha256, section, stage, evidence, modalities[], applicability, equipment{family,types,endConnections}, threshold?, prerequisites?, onFail?, approval?, origin:"library" }`. Modalities come from the evidence type (`Photo or video` → photo, video; `3D scan` → pointcloud; records → none = `REFERENCE_ONLY`).
- **Unique IDs:** rule IDs are finding join keys; a code printed in two documents (e.g. size row `DN65-100`) is qualified as `DN65-100@<document>`.
- **Configuration:** `REFERENCE_PACK` per CAD model in `cad_models.json`; CAD reference cloud generated per pack and cached by CAD sha256.

## Acceptance

- [x] Rules page counts/search/filters match indexed records (not hardcoded 156/114/10).
- [x] Every rule opens its exact source text; index revision changes whenever a source, the metadata or the parser changes.
- [x] Equipment narrowing is only from rule text; NP-/assembly/test documents stay applicable to every valve.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §§5,7,11 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §6 · CAD registry: `src/cad_models.json` (`model_id` connector)
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) Inspection Rules layout + `bundle.css`; replicate, don't copy markup.

## Test Plan

- Unit (Vitest): committed index equals a fresh build (revision + rules); rule IDs unique; `equipmentMatches` narrows 8.4 to swing check and 5.x to butt-weld ends while NP-004 stays applicable; GEO rules carry thresholds + approval + DEMO_ONLY.
- Contract/UI: `/inspection-rules` counts/search/filters equal the index; reference-only rules excluded from evaluated count.
- Negative: missing index → empty library with designed empty state, no crash.

## Verification

- [x] `npm run index:rules` → 161 rules / 19 documents; API Vitest suite green.
- [ ] Manual: expand 3 rules on the Rules page and compare with the markdown sources.

## Review gate

Implemented on the user's go-ahead of 03 Nov 2026 (issues #2, #4, #7, #11). Edit this file to change scope.
