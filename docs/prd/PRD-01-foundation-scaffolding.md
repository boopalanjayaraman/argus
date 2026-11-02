# PRD-01 — Foundation Scaffolding (Argus)

Status: Awaiting review · Source: Tech Stack §§2–3 · Depends on: —

## Specs

- Create target layout: `apps/web/` (React+TS+Vite+Tailwind), `apps/api/` (Node 22+TS+Fastify), `services/inspection/` (Python 3.11 FastAPI skeleton), `packages/contracts/` (shared Zod schemas/enums, Argus-internal only), `tests/`, `scripts/`, `.env.example`.
- Dark operations theme tokens replicated from UX `bundle.css`/`Main.dc.html` (colors, spacing, radii) into Tailwind config — mockup HTML is reference only.
- Health route `GET /api/v1/health` (optional convenience; Simulator must not require it), web shell with top nav `Argus · Home · Inspection Rules · Reports`, empty states, no login.
- Both apps run locally with one documented command each; CI runs build + lint + tests.

Out of scope: any feature logic, DB/GCS/Meta wiring beyond config placeholders.

## Technical Specs

- **Pattern:** monorepo workspaces; `packages/contracts` is the single source for status enums (`lifecycleStatus`, `outcome`, `ruleStatus`) imported by web, api, and (via generated JSON schema) Python — never duplicated string literals.
- **Configuration:** all secrets server-side only via `.env` (Meta, MongoDB, GCS); `.env.example` lists keys with no values; browser bundle receives no credentials. Config validated at boot with Zod/Pydantic, fail-fast with named missing key.
- **Error format:** `{ error: { code, message } }` everywhere; codes reused by later PRDs (`SESSION_CLOSED`, etc.).
- **Testing:** Vitest + React Testing Library + Playwright smoke (nav renders, health OK); pytest placeholder for Python service.

## Acceptance

- [ ] `npm run build` + tests pass; web shows nav + empty Home; API health responds.
- [ ] No secret in web bundle; no login UI.

## Review gate

Reply `go PRD-01` to implement, or edit this file first.
