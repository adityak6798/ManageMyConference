# CI and release

Status: canonical | Owner: platform | ID: `ENG-CI-001` | Last verified: 2026-08-09

## Implemented pull request and main-branch gates

The checked-in `CI` workflow pins npm `11.12.1` in every job and runs five jobs:

1. `integrity`: locked npm/uv installs; Biome/Ruff; Python CLI tests; context routing/integrity; AST error policy; TypeScript; generated OpenAPI drift.
2. `test-build`: unit, API, and component tests plus production builds.
3. `d1`: migrations/reset followed by Miniflare D1 persistence and reset-idempotency tests.
4. `browser`: random ignored local demo-secret setup and reset followed by the full Playwright reference-slice journey; failed runs upload Playwright traces/screenshots/reports and the Wrangler log as artifacts.
5. `security`: configured full-history gitleaks scanning and `npm audit --audit-level=high`.

All five jobs are intended required branch-protection checks. Branch protection must also require independent approval, resolved review conversations, and disallow force pushes/deletion; because these settings live on GitHub, repository files alone do not prove they are enabled. The reference slice includes automated unauthenticated and forbidden coverage. Provider adapter contracts and deployment smoke tests remain future product/release work.

Not every existing tool emits a governing-document link on failure. Improving remediation output is planned, and documentation must not claim it is already universal.

## Implemented scheduled gate

The weekly `Repository gardening` workflow pins npm `11.12.1` and performs locked npm/uv installs, context integrity, Python CLI tests, generated OpenAPI drift, and npm audit. It is read-only and does not open or merge pull requests.

## Planned release gates

As product domains arrive, add their provider contracts and authorization-negative matrices to required CI. Before competition/release, add the external evaluator, accessibility, performance, and quality-score checks. Before production deployment exists, add preview smoke, credential-gated live-adapter checks, immutable migration preflight, rollback, and a smoke test that prevents promotion on failure.

Current local verification evidence uses `npm run check`, `npm run reset`, `npm run test:d1 --workspace @greenroom/api`, `npm run test:e2e`, and `npm audit --audit-level=high`; all pass for the reference slice as of the verification date.

No successful GitHub gitleaks run artifact was inspected during local verification. The checked-in workflow proves the gate is configured, not that it has executed successfully; confirm that evidence with the first protected-branch CI run.
