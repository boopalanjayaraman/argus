# PRD-02 — Reference Pack & Rule Library (Argus)

Status: Awaiting review · Source: Spec §§5,7,11 · Tech Stack §6 · Depends on: PRD-01

## Specs

- Build `reference-data/cvs6000d-48-demo/`: `manifest.json` (valve type, file hashes/revisions), `cad/` (canonical STEP unmodified + derived `valve.glb` + `features.json` verified anchors), `instructions/` (work-order + manual PDFs), `rules/rules.json` (curated rules with stable ID, printed section, exact quote, page, category, feature(s), modalities, `APPROVED|DEMO_ONLY|REFERENCE_ONLY`, approved threshold only when sourced).
- All media/CAD depict the same 48″ CVS 6000D assembly; derived GLB never labelled as original STEP.
- **CAD registry (decided):** `src/cad_models.json` is the CAD list source. Each entry: `model_id` (opaque connector, e.g. `CVS6000_VALVE`), `display_name`, `revision`, `cad_file` (forward-slash path relative to `src/`), `cad_format`, `sha256`. `model_id` is the join key with the Simulator's `available_simulations.json` — never a filesystem path supplied by a client.
- Global Inspection Rules page `/inspection-rules`: searchable (title/ID/body/source), valve-type + evidence-type filters, category groups with **computed** counts, expand for full excerpt. Reference-only rules browsable, never counted as auto-evaluated.

Out of scope: session rule selection (PRD-06), any tolerance inferred from CAD shape.

## Technical Specs

- **Pattern:** offline indexing script (`scripts/index-rules`) parses sources once into a versioned index (Mongo `ruleLibrary` or versioned file); runtime only reads the index. Indexing is idempotent and content-hashed — same input, same index revision.
- **Configuration:** `REFERENCE_PACK_ID=cvs6000d-48-demo` default; pack path from env, validated at boot (missing pack → friendly error on Home, not crash).
- **Data:** rule record = `{ ruleId, sourceFile, sourceHash, page, section, quote, category, features[], modalities[], applicability, threshold? }`. No field for model-invented criteria.
- **STEP→GLB:** offline OCP/CadQuery conversion in `scripts/`; output checked against STEP feature list; conversion never runs per-request.

## Acceptance

- [ ] Rules page counts/search/filters match indexed records (not hardcoded 156/114/10).
- [ ] Every rule opens its exact pinned quote; GLB orbits and matches STEP geometry.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §§5,7,11 · Tech: [Argus_Tech_Stack.md](../architecture/Argus_Tech_Stack.md) §6 · CAD registry: `src/cad_models.json` (`model_id` connector)
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) Inspection Rules layout + `bundle.css` values; replicate, don't copy markup.

## Test Plan (write before implementation — tests fail first)

- Unit: indexer parses rule record requiring quote/page/section; rejects rule without source or with model-invented threshold.
- Unit: re-indexing identical sources yields identical revision/hash (idempotent); `cad_models.json` rejects duplicate `model_id`, backslash path, missing file, bad `sha256`.
- Contract/UI: `/inspection-rules` counts/search/filters equal fixture index (parametrized, not 156/114/10); reference-only rules excluded from evaluated count.
- Negative: missing reference pack → friendly error state, no crash; GLB labelled with STEP filename → fail review check.

## Verification (after implementation)

- [ ] Run this PRD's full test list + Acceptance above.
- [ ] Manual: expand 3 rules, quotes match source PDFs; orbit GLB vs STEP render. No test red/skipped.

## Review gate

Reply `go PRD-02` to implement, or edit this file first.
