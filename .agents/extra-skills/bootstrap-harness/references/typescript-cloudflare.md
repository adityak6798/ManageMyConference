# TypeScript and Cloudflare pattern

Read only when the target repository chooses or already uses this stack.

## Workspace

- npm workspaces for web, API, and shared contracts.
- Node version file plus pinned npm version and committed lockfile.
- Strict shared TypeScript base extended by every workspace; include a contracts typecheck.
- Biome for TypeScript/JavaScript/JSON/CSS formatting and linting.
- Python `uv` workspace only when repository tooling benefits from Python; use Ruff and a locked environment.

## Runtime

- React/Vite browser client.
- Hono API on Cloudflare Workers.
- Zod runtime contracts shared across client and transport; generate OpenAPI and check drift.
- D1 through a repository port, Drizzle schema for intended shape, and ordered SQL migrations for history.
- R2 or providers only when a real slice needs them; use deterministic fakes first.

## Local harness

- Generate ignored `.dev.vars` only when absent, with a random session secret.
- Gate demo authentication behind an explicit development environment and demo flag; fail closed on missing or misspelled environment values.
- Support environment-overridable ports consistently across dev servers, proxies, health checks, and Playwright.
- Provide D1 migrate/reset commands and make reset idempotent.
- Keep secrets out of committed configuration, health output, logs, and error envelopes.

## CI shape

- Integrity: locked installs, format/lint, context/architecture checks, strict types, generated OpenAPI drift.
- Test/build: unit, API, and component behavior plus Worker dry build and Vite production build.
- D1: migrations/reset and Miniflare persistence tests.
- Browser: Chromium journey against local Worker/Vite; retain failure traces, screenshots, and logs.
- Security: secret scan and high-severity dependency audit.

Keep these jobs only while they provide distinct evidence. Pin tool versions and ensure declared base configuration is actually extended.
