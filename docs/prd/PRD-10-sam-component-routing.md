# PRD-10 — SAM Component Routing (Argus)

Status: Implemented (03 Nov 2026) — written after the fact to record a user-directed change (commit `12c382c`) and its generalisation in this cycle · Source: Spec §9 · Agentic Architecture §5 · Depends on: PRD-06, PRD-07

## Problem

A session has ~70 evaluable rules. Screening every photo and video segment against every rule with a multimodal model is slow, expensive and invites answers about parts that are not in the picture (a bonnet rule judged from a flange close-up). Rules must only be applied to evidence that actually shows the component they are about, and the decision of *which* rules apply must stay deterministic.

## Specs

- **Detect, then route.** For each photo or sampled video segment, SAM 3.1 is asked, one concept per request, whether each configured component of the session's equipment is visible (`flange face`, `metal nameplate`, `bolts on valve bonnet`, `lever arm with counterweight`, `pneumatic cylinder`, …). A component is detected when SAM returns at least one object with confidence ≥ `SAM_MIN_CONFIDENCE` (0.5).
- **Routing table, not a model.** `src/reference-data/visual-routing.json` maps components to rule codes. One mapping per **equipment family**; the family's subtypes are listed together (`Valve`: ball, gate, globe, swing_check, butterfly, plug, control, regulator). A component that exists only on some subtypes lists them (`lever_weight` and `air_cushion`: swing_check; `handwheel`: ball, gate, globe, butterfly, plug). Family and subtype come from the pinned CAD model (`cad_models.json`); an equipment with no mapping is refused (HTTP 422), never routed with another family's table.
- **Routing outcome per rule:**
  - component not detected → rule not applied to this evidence (stays as it was);
  - rule needs information outside the image (document / measurement / test record, by pattern in the routing file) → skipped, unless it is critical (listed critical, or its text says FAIL), then reported `INSUFFICIENT_EVIDENCE` with the reason, without a model call;
  - an uploaded order document satisfies the `document` need: those rules are screened with the order text in the prompt;
  - otherwise → screened by Muse Spark (Tier 1), Muse Wonder review when flagged (Tier 2); the deterministic gate decides.
- **Evidence of SAM.** Each analysed photo/segment stores a `segmentation` observation (component, boxes, confidence, one-bit masks as SVG paths in the still's pixel frame). The photo viewer overlays masks and boxes with component labels (toggle); the evidence row records `detectedComponents`.
- **Cost bounds.** Only components that can route at least one of the session's rules are prompted; concepts run in parallel (`SAM_CONCURRENCY`); results are cached by (still hash, concept, model); photos and video keyframes are downscaled before upload.

Out of scope: SAM box/point prompts, tracking across video frames, CAD-anchored highlights (need a validated image↔CAD transform).

## Technical Specs

- **Modules:** `visual_routing.py` (`get_mapping(family, type)`, `relevant_components`, `select_rules(tasks, detected, source, mapping, order_document)`), `meta_adapter.py` (`detect_components`, `segment_concept`, `parse_sam_events` using Meta's `meta-sam-parser`), `media.py` (model stills), `agents.Orchestrator.dispatch_evidence`.
- **SAM call:** `POST {META_API_BASE}/responses`, `model: sam-3.1`, `stream: true`, `metadata: {include_confidence: "true", mask_encoding: "one_bit"}`, one `input_text` concept + one `input_image`. Stream events parsed with `parse_responses_stream(..., image_segmentation_format())`; masks via `decode_mask_to_svg_path`. A failed concept request is recorded with `error` and is not treated as "component absent".
- **Measured latency:** one concept request took ~80 s on 03 Nov 2026 (live smoke). Hence parallel concepts, caching and video sampling (PRD-07).

## Acceptance

- [x] Unknown family/type → refused; Valve subtypes narrow components (swing check: lever/cylinder, no handwheel/actuator).
- [x] Flange-only photo screens only flange rules; critical record-needing rule → `INSUFFICIENT_EVIDENCE` without a model call; non-critical → skipped.
- [x] Order document lets document-comparison rules be screened with the order text.
- [x] A recorded live SAM 3.1 stream parses into boxes, confidences and mask paths.
- [ ] Photo viewer shows masks for a live session (Docker E2E).

## Test Plan

- pytest `test_worklist.py` (routing, refusal, order context, video skip of decided rules) and `test_meta_adapter.py` (recorded stream parsing, parallel concepts + error reporting).

## Review gate

Approved by the user on 03 Nov 2026 (issue #16: "write the PRD based on your understanding"). Edit this file to change scope.
