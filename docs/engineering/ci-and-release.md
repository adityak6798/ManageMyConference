# CI and release

Status: canonical | Owner: platform | ID: `ENG-CI-001` | Last verified: 2026-08-11 (working tree: commit `4a46216`)

## Hosted CI status, stated plainly

**No hosted CI run exists for any commit on this branch.** The most recent green run of all five
jobs is run `31471037575` at head `10eab436`, the head of pull request #88. That head and this branch
are **divergent**: neither is an ancestor of the other, so this branch is neither ahead of nor behind
the green run. Measured on 2026-08-11, `git merge-base HEAD 10eab436` answers `fd21987` and
`git rev-list --left-right --count 10eab436...HEAD` answers one commit on the run's side and five on
this branch's — this branch was cut one commit before #88's head, so the green run includes one
commit this branch does not have, and this branch has five commits that run never saw. Every result quoted elsewhere in the documentation set is local
unless it names that run.

**`main` is not protected.** On 2026-08-11 `gh api repos/:owner/:repo/branches/main/protection`
answered 404 "Branch not protected". None of the five jobs is a required check today, and neither
independent approval, nor resolved conversations, nor force-push protection is enforced. The
workflow file proves the gates exist; it does not prove anything blocks a merge (`GAP-003`).

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
4. `browser` (`gate:browser`): random ignored local demo-secret setup and `npm run reset`, followed by the whole Playwright acceptance suite — every spec in `apps/web/e2e`, 30 tests across 12 files, not just the reference slice; failed runs upload Playwright traces/screenshots/reports and the Wrangler log as artifacts. Because `CI` is set there, the job starts its own servers rather than reusing anything, so the CI run is always a clean-reset run.
5. `security`: `gate:security` is `npm audit --audit-level=high`; the job additionally runs configured full-history gitleaks scanning as a marketplace action, which is therefore not reachable from `npm run check` or from any gate script.

All five jobs are *intended* required branch-protection checks and none of them is one yet: see the status section above. Protection must also require independent approval, resolved review conversations, and disallow force pushes and deletion. The reference slice includes automated unauthenticated and forbidden coverage. Provider adapter contracts and deployment smoke tests remain future product/release work, and cannot exist before a deployment target does (`GAP-008`).

Not every existing tool emits a governing-document link on failure. Improving remediation output is planned, and documentation must not claim it is already universal.

## Gates the local check deliberately skips

`npm run check` runs `gate:integrity`, `gate:test-build`, and `gate:d1`. The remaining gates
are listed here because the gate-drift check refuses a divergence that is not written down;
run them by hand (`npm run gate:browser`, `npm run gate:security`) before relying on them.

- `gate:browser` — Playwright needs a downloaded Chromium and drives one shared local D1 fixture, so it cannot run concurrently with another agent or another checkout on the same machine. Its slowest CI job is also the one least useful to re-run after every small edit.
- `gate:security` — `npm audit` resolves advisories from the registry, so it needs network and its result changes when nothing in the repository changed. A red audit is a repository-wide event, not a signal about the change in hand.

This section is the single home of that divergence: `tools/check-gate-drift.mjs` reads the bullets
above and fails the build if a gate is skipped locally without an entry here, or has an entry here
while `check` still runs it. [`AGENTS.md`](../../AGENTS.md) states the same divergence and its reason
where contributors are told to run `npm run check`, and points back here (issue #83).

## Coverage

Both workspace `test` scripts pass `--coverage` with the V8 provider and a text reporter over
`src/**`, so the same numbers print locally and in the `test-build` job. No threshold is
enforced yet: the figure is there to be read, and a threshold set before the numbers are
understood would only be gamed.

## Implemented scheduled gate

The weekly `Repository gardening` workflow pins npm `11.12.1` and performs locked npm/uv installs, context integrity, Python CLI tests, generated OpenAPI drift, and npm audit in one job, and installs Chromium to run `npm run test:quality` — the evaluator subset — in a second, uploading its artifacts on failure. It is read-only and does not open or merge pull requests.

## Planned release gates

As product domains arrive, add their provider contracts and authorization-negative matrices to required CI. Before competition/release, add the external evaluator, accessibility, performance, and quality-score checks. Before production deployment exists, add preview smoke, credential-gated live-adapter checks, immutable migration preflight, rollback, and a smoke test that prevents promotion on failure.

Current local verification evidence, measured on 2026-08-11 against the working tree at commit
`ea91650` plus the uncommitted speaker-headshot change: `npm run check` exits 0 (37 tool tests, 132
API tests, 93 web tests, 20 D1 tests, both builds);
`GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e` passes 30 tests immediately after
`npm run reset` and 30 again against the same servers with no reset between; `npm run test:quality`
passes 3. `npm run gate:security` was **not** run in that measurement. The full record, including
what a single-spec invocation does and does not prove, is in the
[quality scorecard](../quality/scorecard.md).

The gitleaks half of `GAP-003` is closed: `gitleaks/gitleaks-action@v2` succeeded as a step of the
`security` job in run `31471037575`, at head `10eab436`, alongside `npm audit --audit-level=high`.
That run does not cover this branch's commits, and branch protection remains absent, so the rest of
`GAP-003` stands.
