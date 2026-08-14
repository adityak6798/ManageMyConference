# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-13

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

- `GAP-025` **Webhook wrapping-key retirement lacks a bulk rewrap command.** Webhook HMAC keys and
  secret-bearing idempotency responses are AES-GCM envelopes with an explicit key version, and the
  runtime accepts a keyring so adding a new current key does not strand old rows. What is absent is
  an operator command that rewrites every old envelope to the current version before its old key is
  removed. Impact: key addition and forward rotation work, but retiring compromised/obsolete key
  material requires a reviewed one-off migration and the old key must remain configured until it
  completes. Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`.
  Closure: a tested, resumable command rewraps subscription and idempotency envelopes, reports the
  versions remaining, and refuses retirement while any row still names the old version.

- `GAP-026` **The trusted webhook egress service is specified but not deployed or live-verified.**
  The Worker adapter fails closed and can communicate only with an authenticated enforcement
  origin, while executable fixtures prove mixed DNS answers and send-time rebinding are refused.
  This repository does not contain the separately operated resolver-and-pinned-connection service,
  and no production endpoint has been exercised. Impact: webhook routes correctly return
  `503 WEBHOOK_UNAVAILABLE` without configuration, but production webhook delivery cannot be
  claimed. Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`.
  Closure: [issue #194](https://github.com/adityak6798/ManageMyConference/issues/194) deploys the
  service and records live mixed-answer, rebinding, TLS-hostname, redirect and token-isolation
  verification.

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
  second case every subsequent request failed with
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

  **What remains open is the original entry:** the runtime still dies rather than degrading, and
  a suite that loses it still fails with misleading assertion errors instead of a diagnosis.
  Ports were one way to provoke that; they were not the only one, and neither the browser-job
  crash of hosted run `31498844956` nor the one above had any port pressure behind it. Owner:
  platform. Governing ID: `ENG-DEV-001`, `ACC-DEMO-SMOKE`. Closure: the suite fails with a
  diagnosis rather than the 22 and 31 misleading assertion errors the two hosted crashes produced
  — a `webServer` health probe between spec files, or a Playwright global setup that fails fast
  when the API stops answering — and the wrangler crash itself is reported upstream with the log
  from `apps/api/.wrangler/wrangler.log` and the `kj` message above.
- `GAP-019` **Closed 2026-08-13. The demo reset now reads the data before it writes.**
  `apps/api/seed/reset.sql` is still a full teardown — it `DELETE`s *every* row of `users`,
  `organizations` and `events`, not the seeded ones, all of them, before inserting the fixture
  back — and `tools/remote-demo-reset.mjs` still runs that file against the **deployed** database.
  That is exactly right for a database holding nothing but seed data, and it is what
  `npm run reset:demo` is for. What was missing was any way for the command to know that this
  database is that database.

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
  organization somebody signed up for, or an event they made. Everything else the reset clears is
  state *about* a demo snapshot with **one exception worth naming rather than glossing**:
  `attendee_itineraries` is keyed on a token hash and references only the event, so an itinerary a
  real attendee built against the *seeded* event is destroyed with all three counts at zero. It is
  anonymous and unrecoverable, and it is not covered. It is also a count at a moment in time, so a
  signup completing between the check and the teardown is destroyed unannounced — the window is
  seconds and nothing serializes it. It says nothing about *whose* rows they are. And it does not
  make the deployment safe to run real workloads on: one D1 database still holds both populations,
  and separating them remains the larger fix this entry chose not to take.

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

  **The half that was missing is closed by issue #175.** The stored outcome is read back:
  `EventTemplateService.applications` carries `event_template_applications.outcome_json` out through
  `GET /api/events/{eventId}/template-applications`, and the event templates workspace leads with a
  card when the event's **most recent** application reads `partial` or `failed`. It names the
  categories that did not land with the destination's own reason for each, says who applied the
  version and when, and its one button re-applies **that version, onto the stored destination range,
  with the categories the original command named** — the row records the selection for exactly that
  reason, so a repair repeats the request that was made rather than a wider one. The card is derived
  from storage on every load and shows only that most recent application, which is a safety rule
  rather than tidiness: an application row is keyed per version, so applying a newer version writes
  its own row and leaves an older `partial` one where it was — and offering *that* as a repair
  would write its payload over the configuration that superseded it, because every category
  converges on the payload it is given. The card therefore clears when the version is applied
  again, and also when any later application takes its place.
  `event-templates.test.ts` drives a slice that fails once and then succeeds, asserts the event
  still reports itself configured in part afterwards, and asserts the second apply clears it.

  What remains, and is the residual risk this entry now records — three things, largest first.

  **A later application hides a partial it did not repair.** "Most recent" is the only reading that
  cannot offer a revert, and it is not the same question as "is anything still missing": a second
  application naming a *different* template, or the same one with a subset of categories, is newer
  and may read `applied` while the category the first one could not write is still unconfigured. The
  signal is then lost entirely rather than merely made inconvenient, which is this issue's own
  failure mode in a narrower case. Answering it properly means asking whether a *category* is
  outstanding rather than whether an *application* was — a per-category reading across applications
  that nothing supports today, because `outcome_json` is a per-application document and no query
  decomposes it.

  **There is no dismissal**, so an
  organizer who repairs the refused category by hand — creating the room a slot wanted, granting a
  capability — keeps the card until they apply that version again; doing so is safe and converging,
  but it is a step they would not otherwise have needed. And **the surface is the templates
  workspace**, which an organizer reaches deliberately. A partial application is not raised on the
  console's landing page or in the operational inbox, both of which are platform-owned surfaces
  (`PRD-OPS-002`); an inbox category for it is the natural next home and is a decision about
  platform's product surface rather than about events. Non-atomicity itself is unchanged and stays
  documented rather than fixed.

  Owner: events. Governing ID: `PRD-EVT-002`. Closure: outstanding work is answered per *category*
  rather than per application, so a later clone cannot hide it, and an operator who never opens
  Event templates is still told — which together mean a decomposed read of the stored outcome and an
  inbox category over it.
- `GAP-020` **Google sign-in has never exchanged a request with Google.** The adapter at
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
  is the one with no observation behind it. Owner: identity-access. Governing IDs: `PRD-IAM-001`,
  `ARC-AUTH-001`, `ADR-004`. Closure: issue #165 — one real sign-in completed against Google, with
  the date, commit and client id recorded here and in the `ACC-IDENTITY-EVENTS` scorecard row, and
  any divergence pinned by a case in `google-oauth-client.test.ts`.

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

- `GAP-025` **Four unguarded content writers do not read the affected-row count, and three of them report a save for a write that matched no row.**
  `d1-content-repository.ts` reads the affected-row count on the unguarded `UPDATE`s a caller reads
  a row for first, except four: `updateProfilePhoto`, `updateProfileWorkflow`, `updateAsset` and
  `completeSpeakerImport`. (Two others — `updateProfile` and `updateSession` — also drop the count,
  and are outside this entry because the port documents both as fixture-only with no production
  caller. The batch writes and the two `ON CONFLICT DO UPDATE` upserts are conditional or
  converging by design, where matching nothing is the correct answer rather than a lost one.)
  Each has the same read-then-write gap the others closed, and the same consequence — a successful
  statement that matched nothing is indistinguishable from one that landed, so the response is a
  200 describing a change to a row that is not there. Concretely: unpublishing an asset another
  organizer deleted a moment earlier answers 200 and reports it private; naming a headshot on a
  profile deleted mid-edit reports the headshot set, because the service falls back to the object
  it constructed rather than to what the store did.

  `completeSpeakerImport` is the mildest of the four and is named rather than excused: nothing
  deletes a `content_speaker_import_rows` row today, so its write cannot currently match nothing —
  but neither does anything delete a `speaker_profiles` row, and two of the other three are profile
  writers, so "the row cannot vanish" is not the criterion that separates them. What separates them
  is that the other three have a caller who reports success to a person.

  The four were left rather than swept up with the writers that were fixed because one of them
  cannot be closed without a decision this repository has not made. `updateProfileWorkflow` is the CSV import's
  writer, and what an import should do with a row that vanished mid-run — skip it, refuse the row,
  fail the batch — is a product question about imports rather than a repair to the write rule. The
  other two want the same answer as the writers that were fixed, and are held with the import so
  that all four are decided together: a file that applies one rule to some of its writers and a
  different rule to the rest is exactly the divergence this entry exists to end, and closing two of
  four would recreate it in miniature.

  Owner: content. Governing ID: `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001`. Closure: all four read
  the count; the import's behaviour on a vanished row is decided and stated where the import is
  documented; and a test per writer drives a row deleted between the read and the write.
