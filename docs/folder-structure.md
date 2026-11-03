# Argus — Folder Structure (as of 02 Nov 2026)

Repo: `argus-code/argus` · Main product repo. Status: **docs-only, no implementation yet** (`src/` is empty).

## Current tree

```text
argus/
├── README.md                        # "Autonomous Inspection AI for ETO, HMLV manufacturing"
├── docs/
│   ├── product_pitch.md             # Problem, ETO vs CTO, ROI, progressive quality gates
│   ├── folder-structure.md          # This file
│   ├── specs/
│   │   └── Argus_Spec.md            # Authoritative feature spec v0.9 (normative)
│   ├── architecture/
│   │   ├── Argus_Agentic_Architecture.md   # One bounded coordinator + tools
│   │   ├── Argus_Tech_Stack.md             # Stack, services, API, storage, build sequence
│   │   └── Argus_Architecture_Diagram.png
│   ├── ux/
│   │   └── Argus click-through-html/       # Design reference mockup (not production code)
│   │       ├── Main.dc.html                # Artboard: values to replicate in Tailwind
│   │       ├── README.md
│   │       ├── ds/argus/components/bundle.css
│   │       ├── assets/                     # Fonts
│   │       ├── vendor/                     # react.js, react-dom.js (mockup runtime)
│   │       └── support.js                  # Mockup runtime
│   └── prd/                         # Per-feature PRDs — review + go-ahead before each build
└── src/                             # EMPTY — implementation lands here per PRDs
```

## Reading order

1. [Argus spec](specs/Argus_Spec.md) — what to build (wins on any conflict).
2. [Tech stack](architecture/Argus_Tech_Stack.md) — how to build it.
3. [Agentic architecture](architecture/Argus_Agentic_Architecture.md) — coordinator/tool boundaries.
4. [PRDs](prd/README.md) — one feature at a time.

## Target layout (created by PRD-01, not yet present)

```text
src/apps/web/  src/apps/api/  src/services/inspection/  packages/contracts/
src/reference-data/cvs6000d-48-demo/  tests/  scripts/
```

Do not create these until PRD-01 is reviewed and given go-ahead.

## Update — 2026-11-03 (source under src/)

All source code now lives under `src/`: `src/apps/{api,web}`,
`src/services/inspection`, `src/packages`, plus data that code reads:
`src/cad_models.json`, `src/data/`, `src/reference-data/`,
`src/inspection_rules/` (18 documents — the Inspection Rules page parses
this folder live via GET /api/v1/instruction-sets; nothing is hardcoded).
Runtime state (`data/`) and docs stay at repo root. Build/start commands
are unchanged (`npm start`, `docker compose up`).

## Update — 2026-11-03 (empty states + lifecycle UX)

Every list page has a designed empty state ("No inspections to display —
create one…", rules/reports/documents likewise). Session pages render by
lifecycle: WAITING waits for Simulator evidence with paste-ID guidance,
RECEIVING/ANALYZING shows live evaluation, READY_TO_CLOSE prompts review
before End Inspection, COMPLETED/TERMINATED are read-only with the
dossier as the primary action.
