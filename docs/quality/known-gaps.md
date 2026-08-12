# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-12 (working tree: commit `bb637d4`)

A gap is something a judge or a contributor would otherwise discover by clicking. Each entry states
impact, owner, evidence, governing ID, and the test that closes it. This register is not a place to
normalize failing tests, security defects, or ambiguous ownership; engineering trade-offs that are
accepted rather than absent belong in the [technical debt register](../exec-plans/tech-debt.md).

Missing brief features are recorded here because they are gaps in the product, not in its
engineering. See [competition traceability](../product/competition-traceability.md) for the
feature-by-feature verdict.

## Verification and process

- `GAP-002` The nine competition features are **derived from issue bodies, not from the brief**. The
  brief is not committed (`EVD-001` records an external locator, an uncommitted local copy, and no
  hash), so the traceability table is a reconstruction. Impact: a mis-derived feature would silently
  become a false claim of coverage. Owner: product. Governing ID: `EVD-001`. Closure: re-derive the
  table against the brief itself, or commit a durable descriptor of it, and record the diff.
- `GAP-003` Repository files prove that CI gates are *configured*, not that they are *enforced*.
  Verified on 2026-08-11: `gh api repos/:owner/:repo/branches/main/protection` answers 404 "Branch
  not protected", so none of the five jobs is a required check, and neither approval nor resolved
  conversations nor force-push protection is enforced. The gitleaks half of this gap is now closed —
  the `security` job, including `gitleaks/gitleaks-action@v2`, succeeded in run `31471037575` at head
  `10eab436`. Impact: a red gate cannot block a merge. Owner: platform. Governing ID: `ENG-CI-001`.
  Closure: enable protection on `main` requiring `integrity`, `test-build`, `d1`, `browser` and
  `security`, then record the settings and one passing required-check run here.
- `GAP-004` **Largely closed by issue #28; one part remains.** Ports are now derived from the
  checkout path rather than defaulted, so concurrent worktrees no longer need manual port
  assignment, and local D1/R2 state is keyed on the API port under
  `apps/api/.wrangler/instances/<api-port>/`, so two instances of one worktree no longer share a
  database. `npm run worktree:status` reports the resolved ports and paths without printing
  secrets, and a database whose migrations no longer match the repository is refused with a named
  diagnostic and a `--rebuild` recovery. See [local development](../engineering/local-development.md#ports-and-local-state-are-per-instance).

  What remains: R2 bootstrap is still the seed upload performed by `npm run reset` rather than a
  first-class provisioning step, and the readiness report covers ports, paths and migration
  identity but not provider state. Owner: developer experience. Governing ID: `ENG-DEV-001`.
  Closure: readiness reports resource/provider state as well.

  The measurement this entry was written from, kept because it is the reason the state directory is
  per instance rather than per worktree: on 2026-08-11 two `wrangler dev` instances of *this*
  worktree on different ports (8887 for a hand-driven demo, 9087 for the suite) shared one
  `apps/api/.wrangler/state/v3/d1` SQLite file, and the browser suite then failed intermittently —
  2 failures across 5 consecutive runs, a different single spec each time
  (`speaker-portal`, `public-event`), none reproducible on its own. With the second instance
  stopped and nothing else changed, 6 consecutive runs passed. The failures looked like ordinary
  assertion failures, so the cost was a developer debugging their own test rather than their
  environment.

  Silently testing *another checkout's* server is a distinct defect with a distinct fix; it is
  tracked by issue #90, because a free port stops a collision but not an override that names a port
  a stranger already holds.
- `GAP-005` Two browser specs are inherently non-idempotent and assert the complement rather than
  the state. Completion of an evaluation and declaration of a conflict are terminal by design, so
  `review-workflow.spec.ts` files its own abstracts each run; no product affordance returns a
  communication delivery to a failed state, so `communications.spec.ts` asserts the recovery when a
  failed delivery exists and the refusal when one does not. Impact, stated plainly: recovery consumes
  its own precondition, so **the recovery half of that test executes only on the first suite run
  after a reset** — in the 2026-08-11 measurement, run 1 of 3; runs 2 and 3 asserted the complement. Any
  claim that delivery recovery "is real", including the one the `ACC-INTEGRATION`
  [scorecard](scorecard.md) row makes, rests on that single post-reset run plus
  `communications-service.test.ts`, `communications-http.test.ts` and the D1 repository test — not on
  a green suite. A green suite is compatible with the recovery path never having run. Owner: quality.
  Governing ID: `ACC-DEMO-SMOKE`. Closure: a product affordance that can return a delivery to a
  failed state, plus a reopen or per-run rubric that lets the review path re-execute
  unconditionally. *The wider re-runnability gap this entry used to describe is closed: on
  2026-08-11 the 30-test suite passed after `npm run reset` and again against the same
  already-running servers with no reset (issue #72).*
- `GAP-006` `tools/check-schema-drift.mjs` compares the migrated database with the declared Drizzle
  schema, and deliberately does **not** compare: UNIQUE and CHECK constraint *names* (SQLite does not
  expose them through pragmas); trigger and view *bodies* (Drizzle cannot express either, so the
  seven migration-created triggers are listed in `UNMODELLED_OBJECTS` and only their presence is
  checked); the *data effects* of migrations that backfill rows; CHECK expression differences that
  survive normalisation, including case; duplicate declarations of an otherwise identical constraint,
  because the diff compares by membership; and table-level options — `STRICT`, `WITHOUT ROWID`,
  `COLLATE`, `AUTOINCREMENT` — which the pragmas it reads never surface. Impact: a divergence in any
  of those survives a green `npm run schema:check`. Owner: platform. Governing ID: `ARC-003`,
  `TST-002`. Closure: extend the model to the missing facets, or record each as accepted with the
  reason it cannot be modelled.

## Missing product capability

- `GAP-007` **Partially closed by issue #60.** Production now has emailed-code sign-in and
  event-scoped bearer tokens; demo impersonation remains development-only. Issue #12 still owns
  durable logout/revocation, rotation/recovery operations, membership administration, audit
  events, and the approved provider ADR. Owner: identity-access. Governing IDs:
  `PRD-IAM-001`, `ARC-AUTH-001`.
- `GAP-008` **Partially closed by issue #61.** The Worker now serves `apps/web/dist`, applies an SPA
  fallback to deep links, and every web API client uses one optional `VITE_API_BASE_URL` (same-origin
  by default). The target is now provisioned and a hosted URL **is** evidenced:
  https://project-greenroom-api.adityak6798.workers.dev, on remote D1 and R2, verified by request on
  2026-08-12 across `/health`, demo sign-in, the public event/schedule/speaker pages, both embeds,
  the R2-served headshot, and `/openapi.json`.

  What remains is the part that makes deployment *safe* rather than merely done: that verification
  was performed by hand and once. No smoke suite runs against the deployed URL, nothing prevents a
  promotion when it would fail, and there is no rollback path — so a broken deploy is discovered by
  a human looking. Owner: platform. Governing ID: `ENG-CI-001`. Closure: run the public/embed/API
  smoke against the deployed URL as a gate, and prevent promotion or roll back when it fails.
- `GAP-009` **Closed by issue #49**: CFP conditions and category-based status routing are persisted,
  rendered by both applicant surfaces, enforced by server validation, and snapshotted on submission.
  Owner: cfp. Governing ID: `PRD-CFP-001`, `PRD-CFP-002`, `ACC-CFP`.
  — conditions expressible in the persisted model, honoured by the applicant renderer *and* server
  validation, with a submission visibly routed to a status or category.
- `GAP-010` **Brief feature 3 is incomplete**: organizer "communications" in the content workspace
  are still log rows rather than sends, and `ContentService.recordMessage` writes a
  `speaker_messages` row and touches no outbox. An organizer can write a template and send it to
  the event's speakers from the console, and **the product now enqueues on its own**: accepting a
  proposal welcomes the speaker and announces each onboarding task, requesting a task tells them,
  assigning or distributing review work tells the reviewer once per round, and an accept/decline
  decision reaches the submitter (issue #66). A published schedule commits an
  `EVT-SCHEDULE-PUBLISHED` record whose drain fans out one confirmation per speaker.
  The calendar half is no longer a download only: an organizer sends an iTIP `METHOD:REQUEST`
  invitation per speaker per session through the outbox, and the portal offers Google and Outlook
  links beside the `.ics` (issue #56). Two things are still open there. The schedule confirmation
  carries a **link** to the `.ics` rather than the attached invitation — the two halves landed in
  different pull requests, and wiring them is one call plus one payload key. And the last step is
  unproven: **no mail client has ever rendered one of these invitations**, because the fixture
  provider sends no mail, so the evidence covers the invitation being built correctly and reaching
  the provider and stops there. Provider selection is credential-gated with live adapters behind it
  (`fixture` remains the default and no live adapter has met a real API).
  Owner: communications-integrations.
  Governing ID: `PRD-COM-001`, `PRD-SPK-002`, `ACC-INTEGRATION`. Closure: issues #52, #66, #82
  (trigger, send, assert rendered content in the browser), #23 (production adapters); #56's
  delivery mechanism has landed and closes when an invitation has been rendered by a real client.
- `GAP-011` **Brief feature 4's AI half is built but unverified against a real model.** Both named
  differentiators now exist: multiple rounds shipped with `1300_review_rounds.sql`, and the
  suggestion port shipped with issue #110 — draft-only by construction, with provenance the
  reviewer reads, a deterministic credential-free fake as the default, and an `off` mode. What is
  *not* proven is the half no amount of code can supply here: **the live adapter has never
  exchanged a request with the Anthropic API.** No credential exists in this repository, its tests
  stub `fetch`, the request shape comes from the Messages API's documentation rather than
  observation, and the staging smoke in
  [review suggestions](../engineering/review-suggestions.md#staging-smoke--required-and-not-yet-performed)
  has not run. Impact: reviewers can use the assistant and see exactly where each draft came from,
  and the draft-only guarantee is enforced in storage and asserted against real D1 — but the
  quality of a *live* suggestion is unmeasured, and the request shape is the most likely thing to
  be wrong on first contact. The same shape of gap as `GAP-012`, for the same reason.
  Owner: review. Governing ID: `PRD-REV-001`, `PRD-AI-001`, `ACC-REVIEW`. Closure: the staging smoke
  run and recorded, with the date, commit and serving model written into that section.
- `GAP-012` **Brief feature 7 is verified against nothing**: the inbound Accelevents registration
  sync now exists end to end — a typed source port, a deterministic in-repository roster as the
  default, a live HTTP client behind the credential-gated `live` switch, and an organizer surface
  with a dry run that writes nothing, an idempotent apply, last-run state and a visible failure
  state. What remains is the part no amount of code can supply here: **it has never exchanged a
  request with the real API.** No Accelevents credential exists in this repository, the client's
  tests stub `fetch`, the request and response shapes come from documentation rather than
  observation, and the staging smoke has not run. Impact: an organizer can operate the integration
  and see what it did, but its correctness against the real platform is unproven, and the shapes
  are the most likely thing to be wrong on first contact. The Airtable half of the same gap is
  unchanged: no mapping configuration, connection test or dry-run preview exists for it (issue
  #23's Airtable product surface).
  Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`. Closure: issue
  #58 — a fixture-backed one-way sync with a visible organizer surface, or documentation that says
  plainly it is not implemented.
- `GAP-016` The generated OpenAPI document is checked for drift but not served, and there is no API
  documentation page. Impact: the public-API bonus is unclaimable as shipped. Owner: platform.
  Governing ID: `ENG-CI-001`, `API-PUBLIC-*`. Closure: issue #59 — the document served from a stable
  route with a rendered docs page, covered by a route test.
- `GAP-017` **The local Worker runtime dies mid-run and takes the browser suite with it.** Twice
  observed: once locally on 2026-08-11 after roughly 45 minutes of uptime, and once in the `browser`
  job of hosted run `31498844956`, where `wrangler dev` printed a bare `✘ [ERROR]` with no message
  and exited 38 seconds into the suite. Every subsequent request failed with
  `ECONNREFUSED 127.0.0.1:8787`, so 22 of 30 tests failed with a 500 where they assert 401 or 200 —
  a signature that reads as a mass authorization regression and is not one. The rerun of that same
  commit was green. Impact: a red `browser` job is not by itself evidence of a defect, and a
  contributor can burn an afternoon on it; conversely the crash could mask a real failure behind
  noise.

  **One cause of this is now found and fixed: the D1 harness was exhausting the machine's
  ephemeral ports.** Every call on a D1 database is an HTTP request to the workerd process over
  its own TCP connection, and `apps/api/test/support/seeded-d1.ts` ran every migration statement
  as its own call — one socket each. Measured on one macOS machine, from a drained socket table:

  | | statements | sockets | time |
  |---|---|---|---|
  | a migrated database, before | 179 | 179 | — |
  | a seeded database, before | 264 | 264 | 1460ms |
  | either, after | — | **1** | 471ms |

  Against an ephemeral range of 16,384 (`net.inet.ip.portrange`, 49152–65535) a suite of eighty
  such databases cannot fit, and `npm run gate:d1` did not: cold, solo and with nothing else
  running, it failed 35 of 79 tests and ended at 16,358 sockets. The failures land as
  `fetch failed` / `Server is not running` / `EADDRNOTAVAIL` on whichever tests run last, which
  reads as a mass regression in whatever domain that happens to be. It also broke unrelated
  network calls on the same machine, `git push` among them. Sending the statements as one `batch`
  fixes it: the same suite now passes — 85 tests in 20s, against ~1,600 sockets rather than the
  16,384 it could not fit into. (The counts differ between measurements because the suite grew
  while this was being diagnosed: 79 tests when it was failing, 85 with the tests below added.)

  Two properties are pinned by tests against a double, both checked by mutation. The statements
  go in one batch. And a batch that fails on the *connection* is reported rather than replayed —
  replaying to find the offending statement is right when a statement is wrong, and is exactly
  the wrong move when sockets are what ran out, since it spends ~180 more of them at the moment
  there are none.

  Two notes from the diagnosis, and the first is **retired rather than advice**. While the suite
  did not fit, it could be run in chunks small enough that it did (a second lane ran its own
  81-test branch that way, all passing), and a
  red local `gate:d1` could be told from a real defect by reproducing it on `origin/main`. Neither
  should be needed again, and neither is a substitute for a green gate: if a run has to be chunked
  to pass, the ceiling is back and that is the finding, not the workaround. The second note stands
  on its own — a cold `wrangler` command with no network prints the same `fetch failed` for an
  unrelated reason, its telemetry dispatcher, which `WRANGLER_SEND_METRICS=false` fixes and which
  has nothing to do with the exhaustion above.

  **What remains open is the original entry:** the runtime still dies rather than degrading, and
  a suite that loses it still fails with misleading assertion errors instead of a diagnosis.
  Ports were one way to provoke that; they were not the only one, and the browser-job crash of
  hosted run `31498844956` had no port pressure behind it. Owner: platform. Governing ID:
  `ENG-DEV-001`, `ACC-DEMO-SMOKE`. Closure: the suite fails with a diagnosis rather than 22
  misleading assertion errors — a `webServer` health probe between spec files, or a Playwright
  global setup that fails fast when the API stops answering — and the wrangler crash itself is
  reported upstream with the log from `apps/api/.wrangler/wrangler.log`.
