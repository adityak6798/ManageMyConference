# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-18

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
- `GAP-033` **`tools/check-css-tokens.mjs` gates one of the two directions a stylesheet and a
  component can disagree in, and it is not the direction that shipped the defect it was written
  for.** The gate walks the stylesheets: it fails an undeclared `var()` anywhere — a stylesheet or a
  component's inline style — and a class a stylesheet selects on that nothing names. It never walks
  the class names a component writes, so `<div className="form-stack">` with no rule behind it
  passes, which is exactly how 26 forms shipped with no spacing before `PLAN-006` found them. The
  reverse pass needs an oracle for the names a component composes at runtime — a class built from a
  template writes no class name anywhere — and `classUsage` has that only in a loose form, tuned so
  that a false "unused" cannot make the gate lie about working code; read backwards, that same
  looseness fails working code. Impact: the class-before-rule defect is caught by looking at the
  page or by the browser suite, not by `npm run check`. A second, smaller looseness survives in the
  covered direction: a class name that collides with an identifier or with unrelated string content
  still reads as used, though prose no longer does. That looseness had kept exactly two rules alive:
  `.spine`, because "spine" is written into the prose of four component files describing the cue
  gutter, and `.denied`, because "denied" is written into six comments, five of them about a refused
  clipboard. Tightening the oracle exposed both. `.denied` (`apps/web/src/styles/workspaces.css`)
  was dead and was deleted; it never had an exemption entry, because until the tightening the gate
  had never reported it. `.spine` (`apps/web/src/styles/shell.css`) is a
  rule published ahead of its first adopter rather than a dead one, so it stays and takes an
  exemption entry instead. `.tabular` is a third case and not an instance of this looseness at all:
  no source has ever named it, so the gate had always reported it, and an exemption entry had
  silenced it on the claim that `index.html` and the embed views were its callers — which was false.
  The `.tabular` half of `tokens.css`'s `table, .tabular` and that entry went together, because the
  gate fails a stale entry whose rule has gone. Owner: engineering. Governing
  ID: `ARC-001`, `ENG-CODE-001`. Closure: the gate collects the class names a component names —
  attribute values and `classes(...)` arguments rather than free text — and fails one no stylesheet
  selects, with an exemption list for the composed names; or this direction is accepted permanently
  and `docs/product/design-language.md` keeps saying so.

## Missing product capability

- `GAP-025` **Webhook wrapping-key retirement lacks a bulk rewrap command.** Webhook HMAC keys and
  secret-bearing idempotency responses are AES-GCM envelopes with an explicit key version, and the
  runtime accepts a keyring so adding a new current key does not strand old rows. What is absent is
  an operator command that rewrites every old envelope to the current version before its old key is
  removed. Impact: key addition and forward rotation work, but retiring compromised/obsolete key
  material requires a reviewed one-off migration and the old key must remain configured until it
  completes. Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`.
  Closure: a tested, resumable command rewraps subscription and idempotency envelopes, reports the
  versions remaining, and refuses retirement while any row still names the old version.

- `GAP-026` **The trusted webhook egress service is deployed, but the full live verification and
  signed API delivery are failing.** The singleton Cloudflare Container is live at
  `greenroom-webhook-egress.adityak6798.workers.dev`; the hourly credential-backed monitor has
  repeatedly passed safe validation, a 204 delivery and redirect refusal, including run
  `31863143295` at main commit `6f6b32c`. That proves a real deployed enforcement path, not the
  former anonymous preview. It does not prove the reason this service exists. Full run
  `31864761848` reached the DNS-rebinding dispatch loop and received HTTP 503 from the egress
  service. The workflow initially reported green because `node | tee` returned `tee`'s status;
  commit `5ba2227` adds `pipefail` and archives stderr, so that result cannot be cited as a pass.
  Follow-up run `31864803497` then failed correctly at the same rebinding dispatch with HTTP 503,
  proving that the workflow repair reports the service failure rather than relabelling it.
  Separately, three signed-delivery attempts reached the deployed Greenroom API but subscription
  creation returned 500 (correlations `6abd6083-351d-40c2-a9bc-938e59160aff`,
  `dce7c7c8-814c-48e1-aa43-388bd9271273`, and
  `e802530e-d93b-49ea-ad16-62d4220e0f03`); no subscription row was committed. The checked-in probe
  target refuses a leaked egress bearer and requires the Greenroom signature wire shape, so it is
  suitable for the end-to-end check once creation works. Impact: ordinary monitoring is live, but
  rebinding refusal and API-to-target interoperability cannot yet be claimed. Owner:
  communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`. Closure:
  [issue #194](https://github.com/adityak6798/ManageMyConference/issues/194) records a genuinely
  passing full probe and one succeeded signed delivery; a stub result does not close it.

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
- `GAP-009` **Closed by issue #49, and that closure is now contested**: CFP conditions and
  category-based status routing are persisted, rendered by both applicant surfaces, enforced by
  server validation, and snapshotted on submission. The 2026-08-18 harness evaluator run
  ([runbook](../engineering/external-evaluator.md#score-status)) reproduced the opposite of the
  rendering half: a question configured with `show when Format equals <value>`, saved, reloaded and
  published as v3, never appeared on the public form for any value of the controlling answer, which
  served 8 of its 9 published questions. Reproduced anonymously and as a signed-in speaker. The
  renderer itself is covered — `apps/web/test/cfp-composer.test.tsx` drives the applicant surface
  and asserts a `visibleWhen` field appearing and disappearing with its controlling answer — so what
  is contested is narrower than the closure sentence reads: the builder-save → publish →
  public-form path, not the renderer, and not the persistence, validation or snapshot halves. Until
  someone re-runs that path by hand, do not treat it as closed.
  Owner: cfp. Governing ID: `PRD-CFP-001`, `PRD-CFP-002`, `ACC-CFP`.
  — conditions expressible in the persisted model, honoured by the applicant renderer *and* server
  validation, with a submission visibly routed to a status or category.
- `GAP-010` **Brief feature 3 is incomplete**: organizer "communications" in the content workspace
  are still log rows rather than sends, and `ContentService.recordMessage` writes a
  `speaker_messages` row and touches no outbox. An organizer can write a template and send it to
  the event's speakers from the console, and **the product now enqueues on its own**: accepting a
  proposal welcomes the speaker and announces each onboarding task, requesting a task tells them,
  assigning or distributing review work tells the reviewer once per round, and an accept/decline
  decision reaches the submitter (issue #66). **The review half of this gap is closed** (issue
  #191): an organizer selects reviewers who still owe evaluations in a round and sends them a
  reminder, once per reviewer per round, through communications' public interface — the console
  reports queued, already reminded, no email on file, or nothing outstanding for each of them, and
  the delivery is in the same history and audit timeline as every other. It has its own
  `reviewer.reminder` trigger type (`1706`) rather than borrowing `reviewer.assigned`, which is the
  substitution this row's `ACC-REVIEW` counterpart ruled out: "you have been given work" and "you
  still have work outstanding" are two different things to tell somebody. What is *not* here is the
  **automated weekly** reminder the private rubric asks for — this is the manual nudge, and a
  recurring occurrence needs its own idempotency key and a scheduled tick.
  A published schedule commits an
  `EVT-SCHEDULE-PUBLISHED` record whose drain fans out one confirmation per speaker.
  The calendar half is no longer a download only: an organizer sends an iTIP `METHOD:REQUEST`
  invitation per speaker per session through the outbox, and the portal offers Google and Outlook
  links beside the `.ics` (issue #56). Two things are still open there. The schedule confirmation
  carries a **link** to the `.ics` rather than the attached invitation — the two halves landed in
  different pull requests, and wiring them is one call plus one payload key. And the last step is
  unproven: **no mail client has ever rendered one of these invitations**, because the fixture
  provider sends no mail, so the evidence covers the invitation being built correctly and reaching
  the provider and stops there. Provider selection is credential-gated with live adapters behind it
  (`fixture` remains the default and no live adapter has met a real API). **The switch is now
  per channel** (2026-08-14): `live` used to demand all eight bindings at once, so a deployment
  with a mail provider and no Airtable account could not turn email on at all. Each channel is
  decided on its own bindings and is still all-or-nothing, and a channel nobody configured is
  the deterministic fake only where `ENVIRONMENT` names a development deployment; anywhere else,
  including a name nobody anticipated, it refuses every delivery rather than reporting a `fake:`
  reference. That direction is deliberate — a production deny-list failed open on `production-eu`
  and wrote projection state claiming a push that never happened. That removes the reason this
  deployment could not send; it does not make a send observed. **The `calendar` field is the
  least portable part and is now stated as a residual**: an invitation reaches a calendar as a
  `text/calendar; method=REQUEST` alternative part, providers express that differently or not at
  all, and whoever configures `EMAIL_API_ENDPOINT` has to check their contract for it before
  relying on `speaker-calendar-invite`.

  Issue #189 adds two things to this picture and one limit worth naming. The composer now sends to
  a **chosen subset** of the roster with a per-recipient preview the server resolves through the
  same call that will send, and the merge-field vocabulary is served by
  `GET /api/communications/merge-fields` rather than hard-coded in the console, so the list an
  author reads is the list the renderer resolves. It searches and selects **by name and address
  only**: filtering by speaker *workflow status* is not available, because this domain resolves its
  audience from `IdentityDirectory.listSpeakersForEvent` and never reads content's profiles — so an
  organizer chasing "everybody whose bio is still outstanding" assembles that selection by hand from
  content's requested-work tracker. And content now enqueues two organizer-initiated messages of its
  own through the `SpeakerReminderDispatchPort` it declares: a reminder keyed per (task, deadline),
  which is the identical key the one-minute sweep builds, and a portal invitation keyed per
  allocated occurrence. `ContentService.recordMessage` is unchanged and still writes a
  `speaker_messages` row that touches no outbox.
  Owner: communications-integrations.
  Governing ID: `PRD-COM-001`, `PRD-SPK-002`, `ACC-INTEGRATION`. Closure: issues #52, #66, #82
  (trigger, send, assert rendered content in the browser), #23 (production adapters); #56's
  delivery mechanism has landed and closes when an invitation has been rendered by a real client.
- `GAP-011` **Closed 2026-08-13.** Multiple rounds and AI-assisted review both exist. The temporary
  staging deployment at commit `83c757389a2468500172fc2a5f7aeeeb46497345` completed the full
  [review-suggestion smoke](../engineering/review-suggestions.md#staging-smoke--completed-2026-08-13):
  deployed fail-safe and manual fallback, schema-valid `claude-opus-5` generation, persisted
  provenance, accept-as-draft with no aggregate, separate completion, revoked-key and live safety
  refusal normalization, and inspection of the identity-free outbound request. The deterministic
  fake remains the credential-free default and CI still stubs the provider boundary.
  Owner: review. Governing ID: `PRD-REV-001`, `PRD-AI-001`, `ACC-REVIEW`.
- `GAP-012` **Brief feature 7 conforms to the published Accelevents contract but is not live-verified**: the inbound Accelevents registration
  sync now exists end to end — a typed source port, a deterministic in-repository roster as the
  default, a live HTTP client behind the credential-gated `live` switch, and an organizer surface
  with a dry run that writes nothing, an idempotent apply, last-run state and a visible failure
  state. What remains is the part no amount of code can supply here: **it has never exchanged a
  request with the real API.** No Accelevents credential exists in this repository, the client's
  tests stub `fetch`, and the staging smoke has not run. A 2026-08-12 conformance pass corrected
  the path, authentication header, pagination, and response envelope against API reference v1.0;
  its test records that retrieval date. Live verification is blocked because API-key creation is
  restricted to an organizer/Enterprise account and the free account exposes no usable key.
  Impact: an organizer can operate the integration and its request matches the published
  specification, but no real tenant has answered it. The Airtable half of the same gap is
  unchanged: no mapping configuration, connection test or dry-run preview exists for it (issue
  #23's Airtable product surface).
  Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`. Closure: a
  paid account credential becomes available and the staging smoke records the date, commit, and
  observed request/response behavior.
- `GAP-016` **Closed by issue #59.** The generated OpenAPI document is served at
  `GET /openapi.json`, and `GET /docs` renders the documentation page. Both stable routes are
  covered by `apps/api/test/api-docs.test.ts`. Owner: platform. Governing ID: `ENG-CI-001`,
  `API-PUBLIC-*`.
- `GAP-017` **The local Worker runtime dies mid-run and takes the browser suite with it.** Three
  times observed here: once locally on 2026-08-11 after roughly 45 minutes of uptime, once in the
  `browser` job of hosted run `31498844956`, where `wrangler dev` printed a bare `✘ [ERROR]` with
  no message and exited 38 seconds into the suite, and once more on 2026-08-13 (below). Two further
  sightings are recorded in the [wave coordination ledger](../exec-plans/competition-waves.md),
  where they were observed: the ephemeral-port measurement of 2026-08-12, and a second crash on
  2026-08-13 carrying the same `Broken pipe` message as the one below. In that
  A fourth hosted sighting on 2026-08-14, in the `browser` job of run `31803323240` (issue #190's
  branch): `reference-slice.spec.ts` failed with `apiRequestContext.get: socket hang up` and the
  runtime printed the same `Broken pipe` line dozens of times. One test failed rather than 22, and
  the same commit's suite had passed locally three times immediately before and passed again after,
  so this one degraded rather than collapsed — worth recording because it shows the crash is not
  always all-or-nothing, and a single red spec is the harder shape to attribute. In that
  second case every subsequent request failed with
  `ECONNREFUSED 127.0.0.1:8787`, so 22 of 30 tests failed with a 500 where they assert 401 or 200 —
  a signature that reads as a mass authorization regression and is not one. The rerun of that same
  commit was green. Impact: a red `browser` job is not by itself evidence of a defect, and a
  contributor can burn an afternoon on it; conversely the crash could mask a real failure behind
  noise.

  A fifth hosted sighting on 2026-08-14, in the `browser` job of run `31835694674` (this lane's
  branch, `67e138d`), with the same degraded shape as the fourth: **two** specs failed rather than
  the suite, both in `agenda.spec.ts` — `not.toHaveText` timing out against an unchanged
  `2 of 2 scheduled`, and a Tab from the select-all control not landing on a session checkbox —
  while the runtime printed `Broken pipe` dozens of times around them. Attribution was checked
  rather than assumed, because the failing file is one this branch edited: the edit was a locator
  scope in a *third* test, neither failing test touches it, and the keyboard one is confined to
  `.agenda-rail` while the branch's new controls are on Sessions & speakers. The same commit
  passed `agenda.spec.ts` alone and the full 79-test suite twice locally against a freshly reset
  fixture, immediately before and after.

  **The rerun of that same commit failed too, and that is the useful part.** It failed on a
  *different pair* of specs — two in `communications.spec.ts` rather than two in `agenda.spec.ts` —
  and this time the runtime did not merely stumble: `npm error Lifecycle script 'dev' failed`,
  `Error: socket hang up`, and then `connect ECONNREFUSED 127.0.0.1:20336` repeated for the rest of
  the run. Two runs of one commit, two disjoint sets of red specs, the worker dying in both, and
  the same commit green locally four times over. A regression cannot select a different pair of
  tests each time; a dying runtime can, and does.

  So the earlier sightings' advice — "rerun and it will be green" — does not hold, and this entry
  no longer says it. What the rerun buys is not a green job but a *second sample*: if the same
  specs fail twice, suspect the change; if different ones do, suspect this gap. Recorded because
  the pattern now has a name and a discriminator, and because a lane can currently be unable to
  show a green `browser` job on CI through no fault of its change — which is a stronger statement
  than the four earlier sightings supported, and one that raises this from an annoyance to
  something that blocks the branch-protection work `GAP-003` describes.

  A sixth sighting, and the first **local** one since the fix above: 2026-08-14, issue #196's
  branch. The same bare `✘ [ERROR]` with no message, 23 specs into an otherwise ordinary run —
  every request after it `socket hang up` and then `ECONNREFUSED 127.0.0.1:20388`, 47 of 73 tests
  failed, and the suite took 19.8 minutes instead of its usual two because most of the failures
  were 30-second timeouts. It is recorded because it satisfies the discriminator the fifth sighting
  just introduced, from the other side: the *same commit* had failed 14 specs for real reasons in
  the run before, and passed 72 in the run after, with nothing changed between them. Two disjoint
  outcomes for one tree.

  One detail the earlier sightings do not carry: the port was this checkout's own derived one, so
  `GAP-004`'s per-worktree isolation had done its job and the runtime died anyway. It is a runtime
  fault rather than a contention one, which narrows where a fix would have to go.

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

  **A third occurrence, on 2026-08-13, finally names the error.** The `browser` job of hosted run
  `31747167652` died 14 minutes in, and this time `workerd` printed a message rather than a bare
  `✘ [ERROR]`:

  ```
  ✘ [ERROR] kj::getCaughtExceptionAsKj() = kj/async-io-unix.c++:186:
            disconnected: ::write(fd, buffer.begin(), buffer.size()): Broken pipe
  ```

  followed by ten frames of stripped `workerd` addresses, `npm error Lifecycle script 'dev'
  failed`, and `ECONNREFUSED` on the derived API port for every later request. So the runtime did
  not fault on our code: it died writing to its own stdout, which is the pipe Playwright's
  `webServer` capture holds — and it had been writing a `request.denied` line per unauthenticated
  poll for fourteen minutes. That is a lead the previous two occurrences did not give, and it is
  what the upstream report in the closure condition needs. 31 of 68 specs then failed as 30-second
  timeouts and missing elements; the whole log contains **no** `request.exception`, which is the
  cheapest way to tell this apart from a real regression. The rerun at the same commit was green.

  **Closed 2026-08-14, with both prevention and diagnosis.** The browser harness no longer routes
  workerd's operator logs through Playwright's captured stdout pipe. `tools/browser-api-server.mjs`
  gives stdout and stderr a durable checkout-local file descriptor at
  `apps/api/.wrangler/instances/<port>/browser-api.log`; product request logging remains enabled.
  The known EPIPE mechanism therefore has no Playwright pipe to break.

  Every browser test also carries an automatic `/health` probe before and after it. If the API
  stops answering for any other reason, the first affected test reports
  `BROWSER API RUNTIME STOPPED ANSWERING`, the current and last completed test, the probe failure,
  the durable log path, and its tail. A checkout-local marker survives Playwright restarting its
  worker, so later journeys are skipped instead of becoming dozens of authorization and timeout
  assertions. This was proved by killing the checkout's `workerd` during
  `reference-slice.spec.ts`: one diagnosed failure, two skipped, rather than three product-shaped
  failures. The ordinary run remained 3/3 green.

  The workerd stdout crash and representative hosted logs are reported upstream as
  [cloudflare/workers-sdk#15202](https://github.com/cloudflare/workers-sdk/issues/15202). Owner:
  platform. Governing ID: `ENG-DEV-001`, `ACC-DEMO-SMOKE`.
- `GAP-019` **Closed 2026-08-13. The demo reset now reads the data before it writes.**
  `apps/api/seed/reset.sql` was a full teardown — an unscoped delete of *every* row of `users`,
  `organizations` and `events`, not the seeded ones, all of them, before inserting the fixture
  back — and `tools/remote-demo-reset.mjs` runs that file against the **deployed** database.
  That is exactly right for a database holding nothing but seed data, and it is what
  `npm run reset:demo` is for. What was missing was any way for the command to know that this
  database is that database.

  **Updated 2026-08-14: the file is no longer a full teardown.** Every cleanup in it now names the
  ids the seed inserts, so a restore rebuilds the demo *beside* a real conference instead of in
  place of it, and `tools/compose-seed.mjs` refuses a bare `DELETE` in any fragment so the
  property cannot be lost by a later edit. The guard below is deliberately unchanged: it reads
  what the database holds, and a real organization on the demo deployment is still worth stopping
  for. What changed is the cost of proceeding — which leaves one thing overstated, recorded here
  rather than quietly fixed: `--destroy-real-data` still says it destroys those rows, and the SQL
  behind it no longer can.

  It now asks. Before the first destructive statement, and after `d1 migrations apply` so the
  tables exist on a database that has never been migrated, the command counts every
  `organizations`, `users` and `events` row whose id the fixture does not insert, and refuses if
  the answer is anything but zero. The seeded ids are read out of `seed/reset.sql` itself rather
  than listed in the tool — the seed is generated, so a fragment that adds a persona must not
  silently become "real data" — and they are matched **positively**, because a self-serve
  organization's UUID looks exactly like a seeded one and any id *pattern* would be worse than
  useless. `assertDemoConfig` is unchanged and still runs first; it answers a different question,
  and both now have to be true.

  **It fails closed, which is the property the whole thing rests on.** An unreachable database, a
  query that errors, a non-zero exit from wrangler, output that does not parse, a missing column,
  a count that is not a whole number: each refuses. There is no path from a question the guard
  could not answer to a teardown that runs anyway.

  The refusal says what it found — how many non-seeded organizations, events and users — and what
  proceeding costs: that `seed/reset.sql` deletes those rows permanently, that there is no backup
  and no export, and that nothing re-creates them. The override is
  `--destroy-real-data <organizations>/<events>/<users>`, separate from `--confirm` and unable to
  be reached without first being shown the counts it must repeat; numbers that no longer match are
  refused, so it cannot be pasted from an earlier run. `--confirm` was not weakened to carry it.
  `npm run reset:demo -- --confirm project-greenroom-api` is unchanged on a clean fixture, which is
  the routine path.

  Evidence: `tools/tests/remote-demo-reset.test.mjs` covers the decisions and every fail-closed
  case; `apps/api/test/demo-reset-guard.integration.test.ts` runs the shipped query against a real
  migrated, seeded D1 — a clean fixture counts zero and proceeds, a database carrying one
  self-serve organization, user and event refuses — and then applies `seed/reset.sql` to that same
  database and watches all three rows disappear, which is what the refusal is a refusal of.

  **What it still does not do.** It counts three tables — the ones whose rows are a person, an
  organization somebody signed up for, or an event they made, judged by what attaches each row to
  a person rather than by "the seed did not write it" (see the false positives below, which is how
  that distinction was learned). Everything else the reset clears is
  state *about* a demo snapshot with **one exception worth naming rather than glossing**:
  `attendee_itineraries` is keyed on a token hash and references only the event, so an itinerary a
  real attendee built against the *seeded* event is destroyed with all three counts at zero. It is
  anonymous and unrecoverable, and it is not covered. It is also a count at a moment in time, so a
  signup completing between the check and the teardown is destroyed unannounced — the window is
  seconds and nothing serializes it. It says nothing about *whose* rows they are. And it does not
  make the deployment safe to run real workloads on: one D1 database still holds both populations,
  and separating them remains the larger fix this entry chose not to take.

  **One false-positive class, found the first time the guard met a real deployment (2026-08-14),
  and closed the same day.** It counted every `users` row the fixture does not name, and *not all
  of those are people who signed up*. Ordinary demo usage writes them: accepting a proposal
  converts a speaker, and `provisionSpeaker` inserts a `users` row with no provider account and no
  membership. The first live reading of the deployed database showed exactly that shape — 1
  organization, 1 event, and **3 users**, of which one was the real signup (a provider account and
  a membership) and two were speakers converted against the *seeded* event.

  The direction was safe — it refuses rather than deletes — but the cost was not cosmetic: the
  routine restore stopped being one command after the demo had been *used* rather than after
  somebody had signed up, which pushes an operator toward `--destroy-real-data` for a restore that
  destroys nothing real. Habituating that flag is the one thing its design exists to prevent.

  **A row now counts when something attaches it to a person rather than to the fixture**, which is
  what "real" was supposed to mean all along:

  - a **user** counts with a provider account (only a completed sign-in writes one), an
    organization membership (only signup or an accepted invitation), or an event role on an event
    the seed did not create. A speaker whose only role is on a seeded event matches none of them.
    If that same person later signs in, the provider account appears and they begin counting —
    the rule follows the evidence rather than a snapshot of it.
  - an **event** counts only when it is outside every seeded organization. The organizer persona
    holds `events:create` on the seeded organization, so creating an event is an ordinary thing to
    click in the demo, and the row it writes is demo state. This sibling of the same defect was
    found by looking for it rather than by meeting it.
  - an **organization** counts whenever the seed did not create it, unchanged: nothing but
    self-serve signup writes one, so no demo path produces a row.

  Both refinements are pinned by mutation in `demo-reset-guard.integration.test.ts`, which drives
  the conversions and the event creation through the same services production uses: reverting
  either makes a case fail that asserts demo usage counts zero, and a separate case asserts a
  speaker who holds a role in a *self-serve* workspace still counts.

  Two more limits on the evidence itself. **Wrangler's `--json` output has never been observed
  here**: the parser is covered against a hand-written model of that shape, and the D1 integration
  test re-wraps real results into the same model, so first contact with the real CLI is where the
  parse is most likely to be wrong — the same shape of gap `GAP-020` records for Google. And
  `d1 migrations apply` still runs *before* the check, which is what lets the count query work on a
  database that has never been migrated; the block is additive today, and a destructive migration
  would need that ordering revisited rather than merely noted.

  **Be precise about what is and is not isolated.** The *authorization* model does separate demo
  personas from self-serve organizations, and does it structurally: every event-owned read and
  mutation goes through `requireEventCapability` against a grant on that exact event, an
  organization-wide capability never substitutes for it, and `findByPersona` resolves a persona
  cookie by pinning `id = seed-<persona>`, so a demo session is always one of four seeded rows and
  can never resolve to a self-serve user. No demo persona can read or write a self-serve
  organization's data. What does not isolate them is the **deployment lifecycle**: one D1 database
  holds both populations, and a reset addresses the database rather than the population. That is
  unchanged; what changed is that the reset now notices.

  Issue #164 is closed alongside this and had to be: both races it names — two concurrent callbacks
  creating two first events, and a failed signup orphaning an organization — would have put a row
  on that database that the guard above refuses on, and an orphan nothing sweeps would have made
  every later reset refuse permanently. The organization a signup abandons is now discarded by the
  signup itself.

  `apps/api/wrangler.toml` therefore no longer states a prohibition: it states the four steps that
  enable Google sign-in on the deployed demo. `GOOGLE_CLIENT_ID` and `GOOGLE_REDIRECT_URI` remain
  commented out because they carry a client id this repository does not have, and
  `GOOGLE_CLIENT_SECRET` is a Worker secret — both are operator actions carrying credentials.
  Owner: platform. Governing ID: `ENG-DEV-001`.

- `GAP-023` **Applying an event template is not atomic across domains, and a half-applied template
  is a state a person has to notice and repair.** There is no cross-domain transaction in this
  repository: `D1DatabasePort.batch` is per-adapter and each domain's repository owns its own
  writes, so "atomic across seven domains" would need a mechanism nobody has built. Issue #102's own
  scope offers the alternative this took — a documented per-domain repairable result that hides no
  partial state — and the implementation holds up its end: every category reports `applied`,
  `skipped`, `incompatible`, `unauthorized` or `failed` with a reason, the overall result reads
  `partial` rather than `applied` when any category failed, and `ARC-FLOW-006` states the guarantee
  rather than implying a stronger one.

  **The half that was missing is closed by issue #175, and completed by #203.** The stored outcome
  is read back: `event_template_applications.outcome_json` travels out through
  `GET /api/events/{eventId}/template-applications`, which carries both what each application did
  and — folded across all of them — what the event still owes. Each outstanding category names the
  destination's own reason, the version that owes it, and when that version was applied, and its
  one button re-applies **that version, onto the stored destination range, for that category
  alone**; the row records the original selection and the range for exactly that reason, so a
  repair is the same act rather than a wider one.

  #175 scoped the card to the event's **most recent** application, which was a safety rule rather
  than tidiness — an application row is keyed per version, so offering an older one as a whole-clone
  repair would write its payload over the configuration that superseded it. #203 replaced the
  convention with a structure that has the same property and none of the cost; see below.

  **All three residuals are closed by issue #203, and only non-atomicity remains.**

  **Outstanding work is answered per category rather than per application.**
  `outstandingConfiguration` in `apps/api/src/domain/events/outstanding-configuration.ts` folds
  every stored application into the categories the *event* still owes: for each category the
  deciding application is the newest one that actually reached it, and the category is outstanding
  only when that application refused it. The safety rule the old card enforced by convention is
  now structural. A repair is one version and one category, so it cannot revert what superseded
  it — if a later application had configured the category, that later one would be the deciding
  application and the category would not be outstanding at all. A `skipped` category is
  transparent, which is the rule that stops an organizer from silencing an outstanding category by
  cloning a template that says nothing about it. The templates workspace now lists one entry per
  outstanding category, each with its own repair, and `GET
  /api/events/{eventId}/template-applications` carries the fold beside the applications.

  **There is a dismissal**, and it is the operational inbox's, which already had the mechanism. Its
  key carries the deciding application's instant, so an organizer who repaired the category by hand
  can say so in one click, while a *new* refusal of the same category writes a new row with a new
  instant and returns.

  **An operator who never opens Event templates is told.** `configuration` is a sixth inbox
  category (`PRD-OPS-002`). The platform decision #188 deferred was made by #203, and it was cheap
  in the end because the events domain answers the question: platform declares one call
  (`EventConfigurationSource`) and holds no knowledge of templates, versions or slices.

  Proven by `outstanding-configuration.test.ts` (the fold, including the issue's own closure
  scenario — template A partial, template B in full, the refused category still reported — with
  three mutations of the rule each verified to fail a test),
  `d1-event-template-repository.integration.test.ts` (the same scenario against real storage, so
  the round trip through `outcome_json` is proven rather than assumed), `platform-inbox.test.ts`
  and `event-templates.test.tsx`.

  What remains is what this entry started as and is not a defect this repository is hiding:
  **applying is not atomic across domains.** There is no cross-domain transaction here, the result
  says so per category, `ARC-FLOW-006` states the guarantee rather than implying a stronger one,
  and re-applying is the repair.

  Owner: events. Governing ID: `PRD-EVT-002`, `PRD-OPS-002`.
- `GAP-020` **Closed 2026-08-14: Google sign-in has now exchanged a request with Google, and a
  real person has signed in.** Recorded before the detail, because this entry existed to say the
  opposite: on **2026-08-14**, against commit **`d14b047`** and OAuth client
  **`629474442220-ab3t4tb1bgddnsfjjkm801puan53chtu.apps.googleusercontent.com`**, one sign-in was
  completed end to end on https://project-greenroom-api.adityak6798.workers.dev by the operator who
  configured it.

  **What that observation actually proves**, which is more than "a button worked". The deployed
  database holds one organizer beyond the seeded fixture, carrying both a provider account and an
  organization membership, alongside one organization and one event it did not have before — so
  the whole path ran against a live Google identity: the authorization request was accepted, the
  code exchanged at the token endpoint, the `id_token` verified against Google's **published**
  key set rather than a generated one, and the account provisioned with its first event and the
  organizer role on it. Every one of those had only ever run against a stub. The authorization
  request itself was inspected on the live deployment before the sign-in: a 302 to
  `accounts.google.com/o/oauth2/v2/auth` carrying that client id, the registered redirect URI,
  `response_type=code`, `scope=openid email profile`, `code_challenge_method=S256`,
  `prompt=select_account`, and a `state`, `nonce` and challenge — with the attempt cookie set.

  **No divergence from Google's documented behaviour was observed**, so no case was added to
  `google-oauth-client.test.ts`; the closure condition allowed for one and did not require it.

  **What is still unobserved**, because one sign-in is one sign-in: every refusal path at Google's
  end (a revoked client secret, a rotated signing key, a `kid` Google has retired, an expired or
  replayed code), the key-cache expiry against the real key set, and the timeout. Those remain
  covered by tests against a stub, which is the same position every other adapter is in and no
  longer a gap peculiar to this one. Owner: identity-access. Governing IDs: `PRD-IAM-001`,
  `ARC-AUTH-001`, `ADR-004`. Closes issue #165.

  The original entry follows, because what it warned about is why the observation was worth
  recording. **Google sign-in had never exchanged a request with Google.** The adapter at
  `apps/api/src/adapters/identity/google-oauth-client.ts` is the entire boundary — one POST to the
  token endpoint, one GET for the key set — and its request shape comes from Google's documentation
  rather than from observation. No OAuth client existed in this repository when it was written, and
  every test of it stubs `fetch`.

  What *is* proven is our side of it, and the distinction matters: `google-oauth-client.test.ts`
  pins the grant type, the PKCE verifier, the fixed redirect URI, the credential travelling in the
  body rather than the URL, a non-2xx becoming a typed refusal that carries the status but none of
  Google's prose, the key cache hitting and expiring, a failure not being cached, and the timeout
  aborting; `google-oauth.test.ts` verifies `id_token` handling against tokens it signs itself with
  a generated RSA key, including the refusals — a foreign signature, `alg: none`, HS256 key
  confusion, an unpublished `kid`, another client's audience or authorized presenter, an expired
  token, a stale nonce.

  None of that says Google accepts the request. This is the same shape of gap as `GAP-011` and
  `GAP-012`, with one difference in consequence: a wrong request shape there degrades one feature,
  and a wrong request shape here means **nobody can sign in**, discovered by the first person who
  configures a client id. Impact: the authentication path most likely to be wrong on first contact
  is the one with no observation behind it. Closure was: issue #165 — one real sign-in completed
  against Google, with the date, commit and client id recorded here and in the
  `ACC-IDENTITY-EVENTS` scorecard row, and any divergence pinned by a case in
  `google-oauth-client.test.ts`. That is what the record above discharges.

- `GAP-022` **Search opens the surface a record lives on, not the record, and its cost is proven
  bounded only against the seed.** Five limits, all deliberate, all worth naming rather than
  discovering: two about search, two about the audit timeline, one about the inbox.

  It was six. The sixth — programme inbox dismissal keys carrying no occurrence, so a condition
  resolved and exactly recreated stayed hidden behind the old dismissal — **is closed** by issue
  #180. The agenda now maintains, in the same write that changes the board, the revision at which
  each session's placements last changed and the one at which each time slot was last retimed; a
  conflict carries the later of the two placements' and the two hours', and platform's key carries
  it. A session nobody has touched keeps its dismissal across every unrelated edit, which is why
  the numbers are per session and per slot rather than one revision for the board. Two
  consequences worth stating rather than discovering: the numbers are **not backfilled**, so every
  programme dismissal recorded before them reads as occurrence zero and its item returns open once
  — the conservative direction, and the reason no migration was needed; and rooms, tracks, added
  slots and slots elsewhere on the board carry no number at all, because no derived condition
  reads any of them.
  See `PRD-OPS-002` and `apps/api/test/platform-inbox.test.ts`.

  The console has **no per-record routes**. Every workspace is addressed by its path plus
  `?event=`, and nothing anywhere reads a selection out of the URL, so the deep link a search hit
  carries is the workspace that holds the record — `/sessions`, `/abstracts`, `/agenda` — and the
  operator finds the row on it themselves. `apps/web/e2e/platform-operations.spec.ts` asserts
  exactly that and no more. The acceptance criterion in issue #99 reads "landing on the exact
  record", and what is true today is "landing on the surface that shows it", which is a smaller
  claim.

  Filtering happens **in memory over projections the console already reads**. There is no index
  and no projection storage, which is what keeps every record under its owning domain's own
  authorization rule (`PRD-OPS-001`) — but it also means one keystroke costs one read per source,
  each section is capped rather than paginated, and the whole answer is bounded by what those
  projections happen to carry. On the seeded event that is a handful of rows and the bound is
  proven. On a conference with a few thousand proposals it is unmeasured, and the honest
  expectation is that the read cost, not the filtering, is what would show first.

  The audit timeline carries the other two, both consequences of choices made on purpose.
  **Nothing scheduled is recorded.** The whole audit wiring is constructed inside
  `fetch`; the `scheduled()` entrypoint builds its own narrow composition and no recorder, so the
  outbox drain and the task reminders leave no trace, and `source: "system"` — which the spec
  describes and a unit test proves — is reachable in production only through the agenda's
  publication batch. **Records are unprunable and outlive their subjects.** The table has no
  foreign keys so a record survives what it describes, and the append-only trigger refuses a
  DELETE, so nothing removes a record: not the seed reset, not a retention migration short of a
  copy-and-rebuild, not an operator. In the local fixture it grows by one row per audited mutation
  across every browser run. Because keys are deterministic and the seed's ids are fixed, an audit
  key also survives a reset while the fact it describes does not, so re-publishing the demo
  event's schedule after a reset converges on the pre-reset record rather than writing a new one.
  The browser spec creates its own event for exactly this reason.

  The operational inbox inherits the same bound in one place worth naming. Its failed-deliveries
  category reads one page of communications' history, so a failure older than that page is not
  shown. The existing surface *can* answer it — `history` is paginated — and the inbox chooses not
  to walk the cursor because an unbounded scan behind a page load is the cost this whole design
  avoids. A narrow event-scoped failed-delivery query on communications' public interface would
  close it at bounded cost; #99 did not take it, because it is that domain's file and another lane
  owns it this wave.

  Owner: platform. Governing ID: `PRD-OPS-001`, `PRD-OPS-002`, `PRD-OPS-003`, `ACC-OPS`.

  Five limits, five closures, each independent of the others. A record-addressable route on at
  least the surfaces search returns — a selection the workspace reads from the query string, and
  hits that carry it — closes the first, and the browser spec's assertion tightens from "the
  surface shows it" to "the record is selected". A measurement against a fixture an order of
  magnitude larger than the seed, with a stated ceiling that the suite enforces, closes the
  second; if it fails, the projection reads are where to look before the filter is.
  Constructing the recorder in the `scheduled()` entrypoint closes the third, and its test is a
  drained delivery appearing on the timeline as `system`. The fourth needs a retention decision
  before it needs code: what an audit record is for, and how long that lasts, is a product question, and the
  answer may legitimately be "forever" — in which case the closure is a documented statement to
  that effect plus a fixture that is reset by rebuilding rather than by deleting. The narrow failed-delivery query on communications' public interface closes the fifth, and
  its test is an inbox that shows a failure older than one page of history.

- `GAP-025` (content) **Closed by issue #202.** Every single guarded `UPDATE` in
  `d1-content-repository.ts` whose caller read the row first and then reports a save now reads the
  affected-row count. That is deliberately a description of a set rather than a rule: three
  attempts at a one-line rule covering this file — "every conditional writer", "every writer that
  addresses one row by id", "every writer whose caller reports success to a person" — were each
  published and each refuted by review, because the file has real exceptions with real reasons
  (`beginSpeakerImport` converges on a quiet zero by design; `replaceLatestAsset` is guarded by a
  partial unique index instead). The adapter's own docblock enumerates the whole file by category,
  with the reason for each, so the claim can be checked rather than summarised. The four this entry named —
  `updateProfilePhoto`, `updateProfileWorkflow`, `updateAsset` and `completeSpeakerImport` —
  answer `false` when no row matched, and each caller that reports success to a person refuses
  instead: naming or clearing a headshot on a profile that has gone, and publishing or
  unpublishing an asset that has gone, now answer exactly as a record that never existed does.
  The decision the entry was waiting on is made and stated in `PRD-SPK-001`: **a CSV import
  refuses the row and reports it**, rather than skipping it or failing the batch — the ledger is
  keyed on the normalized address, so the row stays `pending` and re-running the file converges.
  That also closed the same defect one level up, where `if (profile)` fell through to counting a
  deleted speaker as imported. `updateProfile` and `updateSession` remain on a bare `.run()` and
  are the only writers that do, which both the port and the adapter now say at their own sites.
  Proven by `d1-content-repository.integration.test.ts` (a row deleted between the caller's read
  and its write, one assertion per writer, each verified to fail with its own guard removed) and
  two cases in `content-csv-import.test.ts`.

  **Note for whoever reads the register next: this id was allocated twice.** The webhook
  wrapping-key entry above is also `GAP-025`, and it is the one that survives. The collision is
  recorded here rather than silently resolved by the deletion.

  Owner: content. Governing ID: `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001`. Closure: all four read
  the count; the import's behaviour on a vanished row is decided and stated where the import is
  documented; and a test per writer drives a row deleted between the read and the write.


- `GAP-027` **The submission window has no operator surface for a call that closes while nobody is watching, and the account door is narrower than the product implies.** Issue #190 made the CFP lifecycle account-bound: a scheduled window, owned proposals, drafts, revisions, a submitter dashboard, a confirmation whose recipient comes from the session, and a decision message addressed to the owning account rather than to a form answer. Six limits survived it. **Three closed on 2026-08-14** — the deadline is announced (`#210`), every organization holds the lifecycle templates (`#217`), and the applicant's typing survives a re-open (`#211`) — while a fourth closed only in half: a public-call sign-in no longer provisions a conference, and the narrow door itself remains, which is why that limit is still stated below rather than struck out. Each is left written down rather than deleted, because a residual that vanishes is indistinguishable from one nobody looked at. What remains is stated below, and it shares a cause: the surrounding deployment rather than the domain. `#132`'s guest decision is now bounded here too rather than only referred to.

  **Closed 2026-08-14: the deadline is announced.** Issue #210 shipped two scheduled messages on two new trigger values (`cfp.deadline_approaching`, `cfp.call_closed`, migration `1707`): a submitter holding an unsubmitted draft is written to once inside the two days before the deadline, and an organizer once after it. Both are idempotent per `(event, recipient, deadline instant)`, so a cron that ticks every minute sends one message and moving a deadline is a new fact rather than a repeat. The consent decision — why a draft holder is not asked first — is written into `PRD-CFP-003` rather than only into code.

  **A submitter can only sign in through a door this deployment offers, and it offers one.** `DEMO_MODE=true` turns emailed-code sign-in off and no Google client is configured (`GAP-019`, `GAP-020`), so the only identities that exist here are the four seeded personas — which is what the public call's sign-in card offers, and why the browser journey signs in as `Sam Speaker`. A real submitter creating a *new* account used to be handed an organization and a "Your first event" alongside their proposals; **that is fixed** — the public call page's sign-in link declares its context on the attempt row, and a first sign-in started there provisions an identity and nothing else (`PRD-IAM-001`). The narrow door itself remains: this deployment offers personas and Google, and emailed-code sign-in stays off while `DEMO_MODE` is set.

  **Closed 2026-08-14: every organization holds the lifecycle templates.** Issue #217. The catalogue is provisioned as rows the organization owns — backfilled by migration `1707` for every organization that already existed, and materialized on first resolution and on the organizer's first template list for every organization created after it. An organization that publishes its own wording keeps it, because provisioning only ever writes version 1 of a key with no rows at all. A missing template is now also reported on the event's own timeline rather than only in a Worker log, because `notifyLifecycle`'s catch — written for a transient storage failure — was hiding a permanent one that looked identical to success.

  **The confirmation reaches no mailbox, and some accounts get none at all.** `COMMUNICATIONS_PROVIDERS` is unset, so `DeterministicProvider` marks every delivery sent. The confirmation's recipient and rendered body are asserted against delivery history, which is the strongest claim available without a provider, and it is not the claim "a submitter received an email". Separately, an account with no row in `identity_emails` is recorded as `lifecycle.notification.unaddressable` and receives nothing — reachable today with the seeded `Pat Attendee`, who has no address, which is why the dashboard rather than the message is the guarantee `PRD-CFP-004` makes. And "linked" is not "verified": `identity_emails` carries no verification column, so the strength of the address is whatever the sign-in door established, which on this deployment is a persona button.

  **An anonymous caller can squat one account's proposal key.** A proposal an account owns is stored under `proposal:<userId>:<clientKey>`, which makes a collision between two accounts impossible; the anonymous path keeps the bare key it has always used, because narrowing `submitProposalInputSchema` to forbid the separator would be a breaking input change under [api-compatibility](../interfaces/api-compatibility.md). So an anonymous submission *could* spell a prefixed key and take it, costing that account a refused create — not a disclosure, since the convergence read is owner-scoped either way — and requiring the caller to guess both a user id and the client's UUID. Recorded rather than closed because the fix is a contract change with a 180-day deprecation, for a residual nobody can reach by accident.

  **Closed 2026-08-14: the applicant's typing survives a re-open.** Issue #211. Pressing the button on the proposal already in the form now keeps what has been typed and says so; the rebind that lets somebody escape a conflict raised in another tab still happens, and an applicant who has typed nothing takes the reload path exactly as before.

  **A second one was recorded here and then withdrawn**, which is worth leaving written down. The
  claim was that `CfpWorkspace` seeds its window inputs in a passive effect and so an organizer
  typing a deadline before the form load resolves has it cleared. The next pass checked it: the
  card is behind a `loadingCfp` skeleton, so the read *has* returned before the control exists, and
  the only remaining window is between that commit and the effect — sub-frame, reachable by a
  synchronous `fireEvent` and not by a person typing. It is a test-driver artifact, which is
  exactly what the flake fix treated it as. Left here because a withdrawn residual is otherwise
  indistinguishable from one nobody looked at, and because the commit that recorded it existed to
  deflate over-claims and introduced one.

  **The guest decision still reaches an address nobody proved, now bounded** (issue `#132`).
  A guest proposal's address is a form answer, and the decision notification is the one message
  the product sends to one. An event may now write three such messages to one address —
  so a hundred guest proposals naming one victim cost that person three messages rather than a
  hundred, with the ASCII-folding caveat below — and a refused one is reported on the event's
  timeline rather than swallowed. The
  address is compared as a mailbox rather than as a string: case-folded, with any `+tag` removed,
  because one inbox spelled three ways would otherwise be three separate budgets. **The folding is
  ASCII-only**, deliberately, because it has to be the same folding the stored column is compared
  under and SQLite's `lower()` is ASCII-only; the residual is that spellings of one mailbox
  differing in non-ASCII case are separate budgets, so on an internationalized domain the bound is
  looser than three by a factor the victim's alphabet decides. Folding *differently* on the two
  sides was the state before it, and there the cap never bound for such an address at all. **The
  count is also read before the write rather than atomically with it**, which the service says in
  as many words: enqueues landing together can both pass at cap-1, so the overshoot is bounded by
  request concurrency rather than by the number three. D1 offers no compare-and-set for this shape,
  and a bound on amplification is what the cap is for. Only a delivery
  the caller marked `declared` is counted (`communication_deliveries.recipient_trust`, migration
  `1708`), so a speaker's messages to the same address cannot exhaust a guest's budget or be
  exhausted by it. That is
  a bound on amplification and **not** a verification, which is why `#132` stays open: closing it
  needs an address the applicant has confirmed, and a confirmation mail on a public form is
  itself the send primitive the cap exists to bound. `DEBT-012` and `DEBT-013` stand unchanged.

  Owner: cfp, with the first limit shared with communications-integrations. Governing ID:
  `PRD-CFP-003`, `PRD-CFP-004`, `PRD-COM-001`, `ACC-CFP`. Closure: a confirmed guest address, or
  a decision the product stops sending to an unconfirmed one; and one confirmation observed
  arriving in a real inbox from a staged provider.

- `GAP-030` **The 390px layout audit only catches a min-content overflow when the fixture happens
  to hold a long string.** The organizer overview sat 19px past a 390px viewport because
  `.page-body` declared no track minimum, so the grid track was floored by its item's min-content
  and one unbreakable cell — an email address, in the ordinary case — set the width of the whole
  page. That is fixed at the shell (`minmax(0, 1fr)`, verified across all sixteen organizer
  destinations), but the *audit* that should guard the class is only as sensitive as the data in
  front of it: on a freshly reset fixture every cell is short, nothing exceeds the track, and the
  same defect reintroduced tomorrow would measure clean. It was found only because the review
  specs leave stamped addresses behind (`DEBT-007`), which is to say it was found by accident.

  Impact: a whole category of phone-width defect — a wide child setting its ancestors' width — is
  guarded by a check that passes or fails on fixture history rather than on the layout. The
  document-level clause and the off-screen-control clause disagreeing with each other is the
  symptom to watch for: the first passes because the inner `.table-wrap` scrolls its own overflow,
  while the second reports controls outside the viewport. Owner: quality. Governing ID:
  `ACC-DEMO-SMOKE`. Closure: the audit renders a deliberately long unbreakable string into one row
  of each measured surface before measuring, so the floor is a property of the check rather than of
  the seed — or each surface gets a component-level test that asserts the constraint directly.
- `GAP-032` **The console rebuild (`PLAN-006`) drew several surfaces that the API cannot yet fill,
  and left four narrower things undone.** A design pass may not invent a contract, so each of
  these is a surface that is honest about what it does not know rather than one that guesses. They
  are listed together because they share a cause and would otherwise be discovered one at a time by
  clicking. Owner: as named per item. Governing ID: `PRD-PUB-001`, `PRD-AGD-001`, `PRD-COM-001`,
  `PRD-IAM-001`, `ACC-DEMO-SMOKE`.

  **Five need API or contract work.**

  - **A public event page cannot be the event's own colour.** `--accent` is a slot every public
    surface is authored against, and only two things can fill it: an organization portal, from the
    `primaryColor` it stores, and an embed, from the option the host page's snippet passes. The
    event projection carries no brand colour at all, so `/events/:slug` renders in Greenroom's
    green no matter whose conference it is. Owner: publishing. Closure: the event projection
    carries a validated colour and `PublicEventApp` sets it on `.public-shell` the way
    `PublicSiteApp` already does.
  - **The agenda's published-version chip is session-scoped.** There is no read for the current
    publication — the routes are `GET …/agenda`, `…/schedule-reconciliation`, `…/criteria`,
    `…/availability` and `…/generated-drafts`, and none of them answers "what is live". So the
    board states what it *knows*: nothing until this session publishes, and after that the version,
    when it happened, and how many parts have moved since. A reload forgets it. This replaced a
    six-second toast, so it is strictly better and still not a read. Owner: agenda. Closure:
    `GET /api/events/{eventId}/agenda/publications` (or the current publication on the agenda
    projection), and the chip reads it on load.
  - **The Sessions embed cannot be issued as a named address.** `embedViewSchema` is
    `["schedule", "speakers", "gallery", "itinerary"]`, so the sessions view can be copied as a URL
    but not persisted as an embed with a token and a revocation. The control says exactly that
    rather than offering an issue button that would 400. Owner: publishing. Closure: `"sessions"`
    joins the enum, with its migration and its embed renderer, and the hint comes out.
  - **The composer has no test send.** "Send one to myself" is the obvious affordance next to a
    server-resolved per-recipient preview, and it was not built because there is no test mode in
    the outbox: the send would write a real `communication_deliveries` row into the same history
    and audit timeline as a real broadcast, against a real address. Owner:
    communications-integrations. Closure: a delivery the outbox marks as a test — excluded from
    history counts and from the recipient budgets `GAP-027` describes — or a rendered preview that
    is explicitly not a send.
  - **The workspace switcher cannot name an organization.** `sessionResponseSchema.organizations`
    is `{ id }` and nothing else, so the console says "Current organization", or "The organization
    behind <event>", or a truncated UUID. It used to print "Organization 2", which was the console
    reading out an array index. Owner: identity-access. Closure: the session payload carries the
    organization's name, and the label is the name.

  **Four are narrower, and are recorded so they are not mistaken for oversights.**

  - **The control tier reached most surfaces, not all of them.** Counted in `apps/web/src` with
    comments stripped, native `<select>`s went 72 → 41 and native `date`/`time`/`datetime-local`
    inputs went 20 → 21 across the rebuild. `ui/fields.tsx` and `styles/controls.css` head their
    files with the same two before-figures; an earlier revision of both said 73 and 21, and this
    register carried a reconciliation for the difference that was invented rather than measured.
    There is nothing to reconcile — recount before repeating any of these numbers. The date figure
    rose by one because two larger movements nearly cancel. The agenda went 4 → 10: it replaced
    four `datetime-local` fields with six date and time inputs — a day, a start and an end on each
    of the slot editor and the new-slot row — and added four more, on slot generation and
    copy-a-day, that had no date control before. Against that +6, five call sites elsewhere moved
    to `DateField`/`DateTimeField` and left the count: two in `cfp/CfpWorkspace.tsx`, two in
    `PublishingWorkspace.tsx`, one in `workspaces/api-clients.tsx`. There is no `TimeField` call
    site anywhere. An unconverted control
    still takes the reset and the height, so it looks like the tier and does not carry its keyboard
    rules — that difference is the cost, and it is invisible until somebody drives it from the
    keyboard. Where the remainder sits, as *selects · date and time inputs*:
    `content/ContentOperations.tsx` 9 · 1 (its selects grew from 6), `cfp/CfpWorkspace.tsx` 6 · 0,
    `agenda/AgendaWorkspace.tsx` 3 · 10, `content/DeliverableTracker.tsx` 3 · 0, `App.tsx` 2 · 2,
    `CrmWorkspace.tsx` 2 · 2, `content/SpeakerOutreach.tsx` 2 · 1, `review/ProposalActions.tsx`
    2 · 0, `review/RoundsPanel.tsx` 2 · 2, `events/EventTemplatesWorkspace.tsx` 1 · 2,
    `CrmDirectoryWorkspace.tsx` 1 · 1, and one select each in `CustomRolesWorkspace.tsx`,
    `agenda/UnscheduledRail.tsx`, `cfp/controls.tsx`, `content/ChecklistEditor.tsx`,
    `content/SessionEditor.tsx`, `content/SpeakerContent.tsx`, `review/ReviewerProgressPanel.tsx`
    and `review/RubricForm.tsx`. `CrmWorkspace.tsx`'s two owner selects are a deliberate exception
    documented at the top of that file: their `aria-invalid` and described-by wiring is the contract
    with the server's field errors, and acceptance tests read the element's own options. Owner: the
    lane owning each surface; product owns the count. Closure: each listed surface converts or
    records why its control stays native, and this bullet is deleted when the count reaches zero —
    measured, not asserted.

  - **The organizer axe sweep no longer reaches every tool panel.** The sweep used to open all
    seven inline `details.tool-panel` tools; most of them are now drawers, which render nothing
    until they are opened, so `lifecycle-demo.spec.ts` replaced its fixed panel count with
    `openEveryDisclosure` (every `<details>`, whatever its class) plus `auditDrawer` for the two
    largest — the agenda's rooms/tracks/times editor
    and the CFP public-form preview. The decision dialog, the portal editor and the
    withdraw/unpublish confirmations are exercised by the journeys that open them and are **not**
    axe-audited. Owner: quality. Closure: the sweep enumerates drawers the way it enumerates nav
    destinations, so a new one joins the audit loudly rather than silently.
  - **The CFP composer is no longer in the landing captures.** The form-builder shot was retired
    because the fixture's form has no routing rules — its own Routing pane read 0 — and no public
    address, so the picture was headed by a warning banner and its caption claimed conditional
    routing the fixture does not have. The four captures now read as one pass through the lifecycle
    instead. Owner: product. Closure: the seed grows a CFP form with routing rules and a public
    address, and a fifth capture proves it.
  - **One suspected CFP defect was seen and deliberately not touched**, because it is product code
    in another domain's file. On one fixture state `/program?tab=forms` printed "This form is
    published, but the event has no public page yet" while `/publish?tab=event-site` reported
    "Published · Snapshot matches the draft" and the live site rendered a Call for proposals link.
    The banner is `const unreachable = Boolean(liveStatus) && !absoluteUrl` at
    `apps/web/src/cfp/CfpWorkspace.tsx:672`, where `absoluteUrl` derives from the form's own
    `publicUrl`. Owner: cfp. Closure: reproduced and fixed, or shown to be correct and this bullet
    deleted.

- `GAP-031` **Browser journeys now cover every named surface; a staged scheduled-report send is
  still absent.** `zz-closure-surfaces.spec.ts` drives a custom event role and asserts both the
  serialized absence of hidden email/abstract fields and the 403 field error on a locked bio;
  exports and reads CSV, XLSX and JSON; opens and revokes an anonymous report capability URL;
  creates, publishes, registers against and withdraws an organization portal; and issues, reads
  and withdraws a persisted embed. That work found two unreachable implementations rather than
  merely adding tests: anonymous `/sites/:slug` had no web root at all, and the webhooks client
  omitted the idempotency header every configured mutation route requires. Agenda draft generation
  is already driven by `agenda.spec.ts`; the webhooks journey drives the actual local deployment
  state and confirms it remains explicitly unconfigured rather than inventing a successful
  lifecycle.

  **Scheduled report delivery still has not reached a mailbox or staged provider.** The browser
  journey creates a due schedule and invokes the Worker's real scheduled handler. This local
  deployment has no `AUTH_EMAIL_ENDPOINT`/`AUTH_EMAIL_TOKEN`, so the run is observed as `failed`
  with the exact configuration reason and then removed. `reporting.test.ts` exercises a successful
  provider boundary and resolves its delivered URL to masked live rows, but that provider is an
  in-memory stub and is recorded as such. The same pass found and fixed two adjacent defects: cron
  links previously lacked the frozen event authority needed to resolve their report, and a provider
  failure left an undelivered live capability behind; schedules now persist bounded delegated
  scope and revoke a link whose delivery fails.

  It sends through the same provider-neutral binding pair the emailed sign-in code uses,
  `AUTH_EMAIL_ENDPOINT`/`AUTH_EMAIL_TOKEN`, which are unset on a demo deployment — so `deliver`
  throws and the run is recorded as `failed`, deliberately, because an unconfigured deployment
  must not look like a working one. The provider round trip is unexercised outside its own test. It is also
  deliberately **not** in the communications outbox: queueing there needs a new
  `communication_deliveries.trigger_type`, a pinned `CHECK` and therefore a table rebuild in
  another lane's migration block, so these sends do not appear in the communications history or
  share its retry ladder. `DEBT-014` records the same trade from the capability-link side.

  Owner: platform. Governing ID: `PRD-OPS-004`, `ACC-OPS`. Closure: one scheduled report observed
  arriving from a staged provider; every browser-surfaces clause is closed.
