# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-14

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
  origin. `apps/webhook-egress` now contains the separately operated Node implementation,
  executable mixed-answer and rebinding checks, a live-probe command, hourly monitor definition,
  and bearer-rotation procedure. It has not been durably deployed; the only hosted experiment was
  an anonymous expiring preview and is not evidence. Impact: webhook routes correctly return
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

  Owner: content. Governing ID: `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001`.

  Owner: content. Governing ID: `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001`. Closure: all four read
  the count; the import's behaviour on a vanished row is decided and stated where the import is
  documented; and a test per writer drives a row deleted between the read and the write.


- `GAP-027` **The submission window has no operator surface for a call that closes while nobody is watching, and the account door is narrower than the product implies.** Issue #190 made the CFP lifecycle account-bound: a scheduled window, owned proposals, drafts, revisions, a submitter dashboard, a confirmation whose recipient comes from the session, and a decision message addressed to the owning account rather than to a form answer. Six limits survive it, and they are stated together because they share a cause — the surrounding deployment rather than the domain. One further limit belongs to `#132` rather than here: a *guest* proposal has no account, so its decision is still addressed to an unverified form answer.

  **Nothing announces the deadline before it passes** (issue #210). The window is enforced at the application boundary and displayed on both surfaces, but no reminder reaches anybody: an organizer who set a deadline and forgot it discovers the call closed from a quiet inbox, and a submitter with an unsubmitted draft is never told it is about to become unsubmittable. Both would be `proposal.submitted`-shaped deliveries with a scheduled trigger, which is a communications-owned decision (which trigger, whose cadence, and whether a draft holder has consented to be reminded) rather than a CFP one.

  **A submitter can only sign in through a door this deployment offers, and it offers one.** `DEMO_MODE=true` turns emailed-code sign-in off and no Google client is configured (`GAP-019`, `GAP-020`), so the only identities that exist here are the four seeded personas — which is what the public call's sign-in card offers, and why the browser journey signs in as `Sam Speaker`. A real submitter creating a *new* account is the Identity lane's outcome-3 path (`SignupService.signInWithGoogle`), which today provisions an organization and a "Your first event" alongside the person's proposals. Nothing in this lane makes that worse and nothing in it fixes it.

  **No lifecycle message reaches any organization but the seeded one** (issue #217). Every
  template — this issue's confirmation and the eight that predate it — exists only in
  `seed/reset.sql` for organization `00000000-0000-4000-8000-000000000010`, so on any other
  organization `prepare` refuses and `notifyLifecycle` swallows it. Invisible today because
  `GAP-019` leaves one organization here and no provider is configured; not invisible the moment
  either changes. Found by Copilot review on the #190 PR, filed rather than repaired there because
  it is one provisioning decision across four domains.

  **The confirmation reaches no mailbox, and some accounts get none at all.** `COMMUNICATIONS_PROVIDERS` is unset, so `DeterministicProvider` marks every delivery sent. The confirmation's recipient and rendered body are asserted against delivery history, which is the strongest claim available without a provider, and it is not the claim "a submitter received an email". Separately, an account with no row in `identity_emails` is recorded as `lifecycle.notification.unaddressable` and receives nothing — reachable today with the seeded `Pat Attendee`, who has no address, which is why the dashboard rather than the message is the guarantee `PRD-CFP-004` makes. And "linked" is not "verified": `identity_emails` carries no verification column, so the strength of the address is whatever the sign-in door established, which on this deployment is a persona button.

  **An anonymous caller can squat one account's proposal key.** A proposal an account owns is stored under `proposal:<userId>:<clientKey>`, which makes a collision between two accounts impossible; the anonymous path keeps the bare key it has always used, because narrowing `submitProposalInputSchema` to forbid the separator would be a breaking input change under [api-compatibility](../interfaces/api-compatibility.md). So an anonymous submission *could* spell a prefixed key and take it, costing that account a refused create — not a disclosure, since the convergence read is owner-scoped either way — and requiring the caller to guess both a user id and the client's UUID. Recorded rather than closed because the fix is a contract change with a 180-day deprecation, for a residual nobody can reach by accident.

  **One smaller residual on the applicant's own screen, found by the fifteenth review pass and left deliberately.** Pressing `Continue` on the proposal already being edited reloads
  its stored answers over anything typed and unsaved, saying only "Editing …" — silent loss of the
  applicant's work on a surface whose spec is otherwise emphatic that drops are announced. Nothing
  wrong is persisted and the loss is visible on screen; it is recorded rather than repaired because
  the five repair commits before it each introduced the defect the next review pass found, and it
  is not worth that risk on this branch. Tracked by issue #211. Owner: cfp.

  **A second one was recorded here and then withdrawn**, which is worth leaving written down. The
  claim was that `CfpWorkspace` seeds its window inputs in a passive effect and so an organizer
  typing a deadline before the form load resolves has it cleared. The next pass checked it: the
  card is behind a `loadingCfp` skeleton, so the read *has* returned before the control exists, and
  the only remaining window is between that commit and the effect — sub-frame, reachable by a
  synchronous `fireEvent` and not by a person typing. It is a test-driver artifact, which is
  exactly what the flake fix treated it as. Left here because a withdrawn residual is otherwise
  indistinguishable from one nobody looked at, and because the commit that recorded it existed to
  deflate over-claims and introduced one.

  Owner: cfp, with the first limit shared with communications-integrations. Governing ID:
  `PRD-CFP-003`, `PRD-CFP-004`, `PRD-COM-001`, `ACC-CFP`. Closure: a scheduled deadline reminder
  whose trigger and consent rule are decided by communications; a real sign-in door on a deployment
  where a submitter's first sign-in provisions nothing but their own identity; and one confirmation
  observed arriving in a real inbox from a staged provider.

- `GAP-028` **Issue #189's private-set hardening is not implemented — none of the six capabilities
  it names.** What shipped from that issue is the half an organizer uses daily: re-upload
  versioning (`1406`), structured speaker social links (`1407`), explicit portal invitations
  (`1408`), a requested-work tracker whose reminders are keyed on the deadline, file requests bound
  to a session, a bulk composer with a server-resolved per-recipient preview, and four acceptance
  criteria that were described but unasserted. The hardening section is absent rather than partial,
  and each part is absent in the same way — no storage, no route, no surface:

  **Collaborator access.** A speaker's private set is readable by that speaker and by an organizer
  of the event (`mayReadPrivately`), and nothing grants a second identity — a co-presenter, an
  agent, a colleague — any part of it. **Share links.** No capability token addresses a profile or
  an asset the way `attendee_itineraries` addresses an itinerary; the only anonymous door is the
  publication gate, which is all-or-nothing per asset and closes with the event. **AI remix** of
  speaker-supplied material has no provider port at all — the one AI seam in the repository is
  review's suggestion port, which drafts against abstracts. **SMS**: the word does not appear in
  `apps/api/src`, in the migrations, or in the contracts; every trigger type, template and provider
  adapter is email-shaped. **Locked portal fields.** An organizer cannot freeze a field a speaker
  may otherwise edit; the portal's write surface is fixed in code rather than configured per event.
  **Custom workflow statuses.** `workflowStatus` is the four-value enum `invited`/`onboarding`/
  `ready`/`blocked` in `packages/contracts/src/domains/content.ts`, in contrast with the CRM's
  stages, which issue #197 has just turned into data.

  Impact: a reader of the issue finds six named capabilities with nothing behind them, and the
  `ACC-SPEAKER` row must not be read as covering any of them — it says so. Owner: content.
  Governing ID: `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001`, `ACC-SPEAKER`. Closure: each
  capability lands with its own storage, route, surface and acceptance evidence, or the issue is
  re-scoped and this entry records which were dropped and why. Two of them are decisions before
  they are code: sharing a private set outside the event's roster is an authorization model
  question (`ARC-AUTH-001`), and a second delivery channel is a provider question that reaches
  `0019`'s trigger `CHECK` and every adapter under `PRD-COM-001`.

- `GAP-029` **Issue #197 shipped the configurable sourcing pipeline and none of the three
  capabilities around it.** The board, the semantic categories that survive a rename, the stage
  history table, the rebuild that drops `0015`'s stage `CHECK` (`1501`/`1502`), pointer *and*
  keyboard moves, and stage configuration that refuses to strand a prospect are all present and
  covered — `ACC-CRM` states how far. What is not:

  **Year-round interest forms.** There is no public route by which a would-be speaker can put
  themselves into the pipeline, so every prospect is still typed in or imported by an organizer.
  **Campaigns and engagement ingestion.** Segment outreach exists and converges per contact, but
  there is no campaign object with a lifecycle or a schedule, and nothing ingests engagement: a
  delivery reports queued, succeeded or failed, and no open, click or reply ever reaches a
  prospect's timeline, so the only inbound signal on a prospect is an activity somebody typed.
  **Directory analytics.** The organization dashboard counts contacts, conversions and prospects
  per stage; nothing reports sourcing over time, and `crm_prospect_transitions` — which is the
  table such a report would read — is written by every move and read by nothing but the history
  list.

  Impact: `ACC-CRM` is `shipped` about `JNY-008` while the brief feature it serves stays partial,
  which is the distinction the [scorecard](scorecard.md#how-to-read-this) draws and this entry
  keeps honest. Owner: crm. Governing ID: `PRD-CRM-001`, `ACC-CRM`. Closure: each of the three
  lands with storage, a route, a surface and acceptance evidence — the interest form is an
  unauthenticated writer and is therefore a spam and rate-limiting decision before it is a CRM one,
  the same shape the public CFP submission route already carries — or the issue is re-scoped and
  this entry records what was dropped.

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
