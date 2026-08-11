# CI and release

Status: canonical | Owner: platform | ID: `ENG-CI-001` | Last verified: 2026-08-11

## One definition of green

A gate is a `gate:<name>` script in the root `package.json`, and that script is the only
place a check is named. Everything else derives from it:

- `.github/workflows/ci.yml` has one job per gate, and that job runs `npm run gate:<its own
  name>` plus environment setup (pinned npm, `npm ci`, `uv sync`, Playwright browsers). One
  step is neither: the `gitleaks` marketplace action in the `security` job. It is a check, it
  blocks a merge, and no gate script names it, so `npm run check` does not run it and the
  gate-drift checker — which ignores `uses:` steps — cannot see it either.
- `npm run check` — the handoff gate `AGENTS.md` tells contributors to run — is nothing but a
  `&&` chain of `npm run gate:*`.

`npm run gates:check` (`tools/check-gate-drift.mjs`, run first inside `gate:integrity`, so it
fires in CI and locally) fails the build when the two disagree: a job with no gate script, a
gate script with no job, a raw command smuggled into a CI step, a gate quietly dropped from
`check`, an undocumented divergence, or a CI npm pin that no longer matches `packageManager`.
It self-tests against those eight mutations before reporting success. Add a check by editing
a gate script; never by adding a step to the workflow.

## Implemented pull request and main-branch gates

The checked-in `CI` workflow pins npm `11.12.1` in every job and runs five jobs:

1. `integrity` (`gate:integrity`): gate-drift check; Biome/Ruff; context routing/integrity; Python CLI tests; AST error policy; TypeScript; generated OpenAPI drift; declared-schema/migration drift.
2. `test-build` (`gate:test-build`): unit, API, and component tests with V8 coverage printed for both workspaces, plus production builds.
3. `d1` (`gate:d1`): Miniflare D1 persistence, migration, and deterministic-seed tests. These build their own Miniflare instance, so the job no longer runs `npm run reset` first; the `browser` gate still proves `reset` applies through real Wrangler, and dropping it here keeps `npm run check` from mutating the shared local D1 fixture a concurrent Playwright run depends on.
4. `browser` (`gate:browser`): random ignored local demo-secret setup and reset followed by the full Playwright reference-slice journey; failed runs upload Playwright traces/screenshots/reports and the Wrangler log as artifacts.
5. `security`: `gate:security` is `npm audit --audit-level=high`; the job additionally runs configured full-history gitleaks scanning as a marketplace action, which is therefore not reachable from `npm run check` or from any gate script.

All five jobs are intended required branch-protection checks. Branch protection must also require independent approval, resolved review conversations, and disallow force pushes/deletion; because these settings live on GitHub, repository files alone do not prove they are enabled. The reference slice includes automated unauthenticated and forbidden coverage. Provider adapter contracts and deployment smoke tests remain future product/release work.

Not every existing tool emits a governing-document link on failure. Improving remediation output is planned, and documentation must not claim it is already universal.

## Gates the local check deliberately skips

`npm run check` runs `gate:integrity`, `gate:test-build`, and `gate:d1`. The remaining gates
are listed here because the gate-drift check refuses a divergence that is not written down;
run them by hand (`npm run gate:browser`, `npm run gate:security`) before relying on them.

- `gate:browser` — Playwright needs a downloaded Chromium and drives one shared local D1 fixture, so it cannot run concurrently with another agent or another checkout on the same machine. Its slowest CI job is also the one least useful to re-run after every small edit.
- `gate:security` — `npm audit` resolves advisories from the registry, so it needs network and its result changes when nothing in the repository changed. A red audit is a repository-wide event, not a signal about the change in hand.

## Coverage

Both workspace `test` scripts pass `--coverage` with the V8 provider and a text reporter over
`src/**`, so the same numbers print locally and in the `test-build` job. No threshold is
enforced yet: the figure is there to be read, and a threshold set before the numbers are
understood would only be gamed.

## Implemented scheduled gate

The weekly `Repository gardening` workflow pins npm `11.12.1` and performs locked npm/uv installs, context integrity, Python CLI tests, generated OpenAPI drift, and npm audit. It is read-only and does not open or merge pull requests.

## Planned release gates

As product domains arrive, add their provider contracts and authorization-negative matrices to required CI. Before competition/release, add the external evaluator, accessibility, performance, and quality-score checks. Before production deployment exists, add preview smoke, credential-gated live-adapter checks, immutable migration preflight, rollback, and a smoke test that prevents promotion on failure.

Current local verification evidence uses `npm run check`, `npm run reset`, `npm run test:d1 --workspace @greenroom/api`, `npm run test:e2e`, and `npm audit --audit-level=high`; all pass for the reference slice as of the verification date.

No successful GitHub gitleaks run artifact was inspected during local verification. The checked-in workflow proves the gate is configured, not that it has executed successfully; confirm that evidence with the first protected-branch CI run.
