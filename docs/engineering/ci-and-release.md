# CI and release

Status: canonical | Owner: platform | ID: `ENG-CI-001` | Last verified: 2026-08-12

## Hosted CI status, stated plainly

Hosted CI runs on pull requests and pushes to `main`. Run `31650751784` passed all six gates at
`2e9ec0c` on 2026-08-12. Results quoted elsewhere remain local unless they name a hosted run.

**`main` is not protected.** On 2026-08-11 `gh api repos/:owner/:repo/branches/main/protection`
answered 404 "Branch not protected". None of the six jobs is a required check today, and neither
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
`check`, an undocumented divergence, or an npm pin — in the workflow *or in the shared setup
action* — that no longer matches `packageManager`. It self-tests against those nine mutations
before reporting success. Add a check by editing a gate script; never by adding a step to the
workflow.

## Implemented pull request and main-branch gates

Every job bootstraps through one repository-owned composite action,
[`.github/actions/setup`](../../.github/actions/setup/action.yml) — Node from `.nvmrc`, the npm
version `packageManager` pins, `npm ci`, and, behind a `python: "true"` input, the uv-managed
Python toolchain that only `gate:integrity` needs. The bootstrap therefore has one definition
instead of five copies. The **jobs** stay separate on purpose: each gate's failure remains
independently visible, each runs with least-required permissions, and none inherits another's
build output or database state. Because the action is a `uses:` step, the gate-drift checker
still sees exactly one `run:` per job — its own gate — and it reads the action directly for the
npm pin, so moving the bootstrap did not take that check out of service.

The workflow runs six gate jobs:

1. `integrity` (`gate:integrity`): gate-drift check; Biome/Ruff; context routing/integrity; Python CLI tests; AST error policy; TypeScript; generated OpenAPI drift; declared-schema/migration drift.

   `greenroom-context check` also holds the canonical documents to each other and to declared
   state, not only to well-formedness. One row per acceptance ID with a verdict from a closed
   set, and a row for every ID a domain declares; every plan carrying a lifecycle status, in the
   document that status names, and in only one of them; `Last verified` as an ISO date; and no
   sentence claiming a resource `context/architecture.json` declares **configured** is not
   there yet. That last rule is why `ARC-003` no longer describes the asset bucket as a future
   plan while it is bound in `wrangler.toml` and `R2AssetStorage` is wired in the Worker — and
   the rule is strict enough that it fires on this paragraph if the old sentence is quoted here
   verbatim, which is the point. Freshness is not enforced as an age — a document does not rot
   on a timer — but
   the date has to be machine-readable to be checkable at all. Nothing here interprets prose:
   each rule reads a table written in a fixed shape, or a declared field.
2. `test-build` (`gate:test-build`): unit, API, and component tests with V8 coverage printed for both workspaces, plus production builds.
3. `d1` (`gate:d1`): Miniflare D1 persistence, migration, and deterministic-seed tests. These build their own Miniflare instance, so the job no longer runs `npm run reset` first; the `browser` gate still proves `reset` applies through real Wrangler, and dropping it here keeps `npm run check` from mutating the shared local D1 fixture a concurrent Playwright run depends on.
4. `browser` (`gate:browser`): random ignored local demo-secret setup, a production web build, and `npm run reset`, followed by the whole Playwright acceptance suite — every spec in `apps/web/e2e`, 30 tests across 12 files, not just the reference slice. The build is a prerequisite because Wrangler serves `apps/web/dist`, which does not exist in a clean checkout; failed runs upload Playwright traces/screenshots/reports and the Wrangler log as artifacts. Because `CI` is set there, the job starts its own servers rather than reusing anything, so the CI run is always a clean-reset run.
5. `evidence` (`gate:evidence`): refuses a quality-scorecard row whose stated verdict no run supports. Each suite writes a record under `.evidence/` — suite, command, exit status, counts, commit, timestamp — and this gate fails a row citing a suite with no record, a record from another commit, a record of a failing run, or a spec file that no longer exists. It is the one job that consumes another job's output, and what it consumes is read-only JSON: `test-build`, `d1` and `browser` upload their records with `if: always()`, and this job downloads and merges them. No build output and no database crosses between jobs. It runs `if: always()` after those three so a red suite produces a red evidence gate rather than a skipped one.
6. `security`: `gate:security` is `npm audit --audit-level=high`; the job additionally runs configured full-history gitleaks scanning as a marketplace action, which is therefore not reachable from `npm run check` or from any gate script.

All six jobs are *intended* required branch-protection checks and none of them is one yet: see the status section above. Protection must also require independent approval, resolved review conversations, and disallow force pushes and deletion. The reference slice includes automated unauthenticated and forbidden coverage.

## Main-branch deployment

The `deploy` job is a release action, not another gate. It runs only for a push to `main`, declares
all six gate jobs in `needs`, and runs `npm run deploy` only after they succeed. That command first
applies every pending remote D1 migration and stops on failure; only then does it build the web
artifact and upload the Worker. Code that expects a new table therefore cannot deploy over a
database whose migration failed. D1 captures a backup and rolls back a failing migration, while
already-completed earlier migrations remain valid deployed history. The job reads
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub repository secrets; neither value
belongs in source, workflow literals, artifacts, or logs. `tools/check-gate-drift.mjs` recognizes
this one non-gate job and enforces its branch condition, complete dependency list, and sole command.

Main deploy jobs share one non-cancelling concurrency group. After a queued job acquires that lock,
it fetches `origin/main` and refuses unless the workflow SHA is still the branch head. Thus a newer
push may deploy first, but an older run can never subsequently overwrite it. The drift checker
enforces the concurrency block, stale-head guard, and upload ordering.

The previous Cloudflare Workers Builds connection was removed rather than repointed. It belonged
to the placeholder `managemyconf` service, whose URL returned `Hello world`, while its successful
`Workers Builds: managemyconf` check appeared on this repository's commits. Keeping two deployment
owners would leave a second green signal with no relationship to `project-greenroom-api`; the
GitHub Actions job is now the sole repository-triggered deployment path.

A deploy exit code is not release verification. After a main deployment, follow the request-based
smoke in the [deployed demo runbook](../demo-runbook.md): health, organizer demo session, public
event/schedule/speakers, both embeds, and the R2-served headshot.

### What sharing the bootstrap did and did not buy

Measured on run `31531729275` (head `5f1a90a`, warm caches), the last full green run before the
setup action existed. Per job, summing `setup-node`, `setup-uv`, the npm pin, `uv sync` and
`npm ci`:

| Job | Setup | Job total |
|---|---|---|
| `integrity` | 12s | 44s |
| `test-build` | 17s | 51s |
| `d1` | 14s | 42s |
| `browser` | 14s | 142s |
| `security` | 13s | 24s |

**Setup was not the bottleneck, and sharing it is not a speed-up.** `actions/setup-node`'s npm
cache was already effective — a warm `npm ci` finishes in 5–7s — so the composite action runs the
same steps in the same order and warm-run wall time is expected to be unchanged within noise. The
duplication removed was in *definition*: five copies of the same four steps, which is where a
version pin or a cache key silently drifts, not where the minutes are. Further optimisation is
recorded here as **not worthwhile**: the remaining setup cost is dominated by action start-up and
tarball extraction, and the largest job's time is Playwright, not bootstrap.

What the action does add is diagnosability, which the duplicated steps never had: it prints the
resolved Node, npm, uv and Python versions and the cache-hit outcome for both caches, so a cache
that quietly stopped working no longer looks identical to one that is working.

Not every existing tool emits a governing-document link on failure. Improving remediation output is planned, and documentation must not claim it is already universal.

## Gates the local check deliberately skips

`npm run check` runs `gate:integrity`, `gate:test-build`, `gate:d1`, and `gate:evidence`. The remaining gates
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
passes 4. `npm run gate:security` was **not** run in that measurement. The full record, including
what a single-spec invocation does and does not prove, is in the
[quality scorecard](../quality/scorecard.md).

The gitleaks half of `GAP-003` is closed: `gitleaks/gitleaks-action@v2` succeeded as a step of the
`security` job in run `31471037575`, at head `10eab436`, alongside `npm audit --audit-level=high`.
That run does not cover this branch's commits, and branch protection remains absent, so the rest of
`GAP-003` stands.
