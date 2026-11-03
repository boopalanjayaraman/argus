# Argus — Folder Structure (as of 03 Nov 2026)

Repo: `argus-code/argus` · Main product repo. Status: implemented (PRD-01…10); runs locally (`npm start` + `scripts/run_inspection.sh`) or as six containers (`docker compose up --build`).

## Current tree

```text
argus/
├── README.md                         # Product pitch summary
├── package.json                      # npm start / test / index:rules / check:ux
├── docker-compose.yml                # api :8000, orchestrator :8100, video :8101, image :8102, pointcloud :8103 (+ opt-in local mongo)
├── Dockerfile.api                    # Fastify API + built web app (+ ffmpeg)
├── Dockerfile.inspection             # Python orchestrator + sub-agents (Open3D, pypdf, meta-sam-parser, ffmpeg)
├── .env.example                      # MongoDB / GCS / Meta / analysis / geometry settings (copy to .env)
├── scripts/
│   ├── run_inspection.sh             # Local: orchestrator + three agent services
│   └── check-ux-classes.mjs          # Fails on ar-* classes not in the design source
├── docs/
│   ├── product_pitch.md
│   ├── folder-structure.md           # This file
│   ├── notes-2026-11-02-cycle-1.md   # Gap register + cycle log
│   ├── specs/Argus_Spec.md           # Feature spec v0.9 (normative; dated amendments)
│   ├── architecture/
│   │   ├── Argus_Agentic_Architecture.md   # v1.0: orchestrator + sub-agents, one deterministic gate
│   │   └── Argus_Tech_Stack.md             # v1.0
│   ├── prd/                          # PRD-01 … PRD-10 + README index
│   └── ux/                           # Click-through mockups + UX_PORT_MAP.md (design source of truth)
├── data/                             # Runtime only (gitignored): db.json, evidence/, documents/, dossiers/, merged/
└── src/
    ├── cad_models.json               # CAD registry: model_id, display_name, family, type, end_connection, reference_pack, cad_file, sha256
    ├── data/CAD_files/               # Registered CAD (cvs6000_valve.stl)
    ├── inspection_rules/*.md         # 19 rule source documents (incl. inspection_09_cad_scan_conformance.md)
    ├── reference-data/
    │   ├── rule-library.json         # Generated index (npm run index:rules) — runtime reads only this
    │   ├── rule-metadata.json        # Stage, evidence, equipment applicability, approved thresholds
    │   ├── visual-routing.json       # SAM component → rule routing per equipment family (Valve + subtypes)
    │   └── cvs6000d-48-demo/
    │       ├── cad/cad_reference.{ply,json}      # CAD-derived reference cloud + source hash
    │       └── customer-documents/               # Demo work order PDF (uploaded through the UI)
    ├── apps/
    │   ├── api/src/                  # server.ts (routes, ingestion, SSE, closure, dossier), rules.ts (indexer/selector),
    │   │                             # analysis.ts (live queue), db.ts/models.ts (Mongo), storage.ts (GCS), logger.ts
    │   └── web/src/                  # App.tsx (all pages), ViewerDialog.tsx (photo+SAM masks/video/3D), PointCloudThumb.tsx, pointcloud.ts
    └── services/inspection/          # app.py (orchestrator HTTP), agents.py (orchestrator + sub-agents), agent_service.py,
                                      # coordinator.py (gate), visual_routing.py, meta_adapter.py (Muse + SAM), media.py,
                                      # documents.py (order documents), geometry.py, cad_reference.py, worklist.py, tests/
```

## Reading order

1. [Argus spec](specs/Argus_Spec.md) — what to build (wins on any conflict).
2. [Tech stack](architecture/Argus_Tech_Stack.md) — how it is built.
3. [Agentic architecture](architecture/Argus_Agentic_Architecture.md) — orchestrator, sub-agents, gate boundaries.
4. [PRDs](prd/README.md) — one feature at a time.
5. [Notes](notes-2026-11-02-cycle-1.md) — open gaps and what closed them.

## Conventions

- Rule sources change → run `npm run index:rules` and commit `rule-library.json` (a test fails when it is stale).
- New CAD model → add to `cad_models.json` with family/type/end connection; a new equipment family also needs a mapping in `visual-routing.json`.
- UI changes reuse the mockup's DOM and classes (`docs/ux/UX_PORT_MAP.md`, `npm run check:ux`).
