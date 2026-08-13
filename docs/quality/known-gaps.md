# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-12

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
- `GAP-019` **The demo reset would delete real self-serve accounts, and its guard cannot tell that
  it is about to.** `apps/api/seed/reset.sql` is a full teardown: it `DELETE`s *every* row of
  `users`, `organizations` and `events` — not the seeded ones, all of them — before inserting the
  fixture back, and `tools/remote-demo-reset.mjs` runs that file against the **deployed** database
  with `wrangler d1 execute DB --remote`. That is exactly right for a database holding nothing but
  seed data, and it is what `npm run reset:demo` is for.

  The guard in front of it reads the repository, not the database. `assertDemoConfig` checks that
  `apps/api/wrangler.toml` still says `name = "project-greenroom-api"`, `ENVIRONMENT =
  "development"` and `DEMO_MODE = "true"`, that the D1 binding names the demo database id and the
  R2 binding the demo bucket, and the CLI additionally requires `--confirm project-greenroom-api`.
  Every one of those is a statement about *configuration*. None of them asks the question that now
  matters: does this database contain an organization nobody seeded?

  Impact: the moment a deployment carries both the demo seed and real self-serve organizations,
  the next reset destroys the real ones — silently, with a successful exit and the message
  `Remote demo restored`. Self-serve signup (`PRD-EVT-001`, `JNY-010`) is what makes that
  combination reachable: product-written rows already accumulated there and were already discarded
  by every reset — `reset.sql` says so of `attendee_itineraries` and `accelevents_sync_runs` — but
  each of those is state *about* a demo snapshot, regenerable by using the demo again. An
  organization somebody signed up for is the first row on that database whose loss cannot be
  undone by re-running anything. There is no backup and no export, so the loss is final; and
  because the demo reset is the routine way to restore the deployment after a demonstration, the
  destructive path is the well-trodden one rather than an accident.

  **Be precise about what is and is not isolated.** The *authorization* model does separate demo
  personas from self-serve organizations, and does it structurally: every event-owned read and
  mutation goes through `requireEventCapability` against a grant on that exact event, an
  organization-wide capability never substitutes for it, and `findByPersona` resolves a persona
  cookie by pinning `id = seed-<persona>`, so a demo session is always one of four seeded rows and
  can never resolve to a self-serve user. No demo persona can read or write a self-serve
  organization's data. What does not isolate them is the **deployment lifecycle**: one D1 database
  holds both populations, and a reset addresses the database rather than the population.

  This is why `apps/api/wrangler.toml` deliberately leaves `GOOGLE_CLIENT_ID` and
  `GOOGLE_REDIRECT_URI` commented out. Google sign-in is implemented and the deployed demo does not
  offer it, precisely so that no real account can accumulate on a database whose restore procedure
  is a full teardown. The two races that would put an unreferenced organization on that database
  even without a completed signup are issue #164, and whichever of the two lands second has to
  account for the first: an accumulated orphan would trip the data-aware guard below permanently.
  Owner: platform. Governing ID: `ENG-DEV-001`. Closure: the remote reset reads
  the data before it writes — refusing when it finds an organization, user or event the seed does
  not name, unless an explicit flag says to destroy them — or the demo and self-serve deployments
  become separate databases. Either one, plus a test that proves the refusal, closes this and makes
  it safe to configure Google on the deployed demo.

- `GAP-023` **Applying an event template is not atomic across domains, and a half-applied template
  is a state a person has to notice and repair.** There is no cross-domain transaction in this
  repository: `D1DatabasePort.batch` is per-adapter and each domain's repository owns its own
  writes, so "atomic across seven domains" would need a mechanism nobody has built. Issue #102's own
  scope offers the alternative this took — a documented per-domain repairable result that hides no
  partial state — and the implementation holds up its end: every category reports `applied`,
  `skipped`, `incompatible`, `unauthorized` or `failed` with a reason, the overall result reads
  `partial` rather than `applied` when any category failed, and `ARC-FLOW-006` states the guarantee
  rather than implying a stronger one.

  What is still missing is everything after the response. Re-applying is the repair and it is safe,
  because every slice converges on a natural key — but nothing *prompts* it. No surface lists events
  whose most recent application was `partial`, the recorded outcome in
  `event_template_applications.outcome_json` is written and never read back by any query, and an
  organizer who closes the tab before reading the summary has no way to learn that one category did
  not land. The failure mode is quiet and shaped exactly like success: an event configured from a
  template, missing one thing nobody mentioned again.

  Owner: events. Governing ID: `PRD-EVT-002`. Closure: the stored per-slice outcome becomes readable
  — a `partial` application is surfaced where the organizer will see it, with the re-apply that
  repairs it one action away — and a test drives a failing slice through apply, asserts the event is
  reported as partially configured afterwards, and asserts a second apply clears it.
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

- `GAP-024` **A materialized per-session schedule revision has no drift detection and no repair
  path.** Issue #141 replaced an unbounded replay of `agenda_publications` with a stored answer in
  `agenda_session_schedules`, maintained inside the batch that commits each publication. The replay
  was self-correcting by construction: it recomputed from the immutable snapshots on every read, so
  a wrong answer was not representable. The stored form gives that up in exchange for the read cost,
  and the failure it admits is silent. `AgendaService.publishedSessionSchedules` returns whatever
  the table holds, and nothing anywhere re-checks it against the board in force. So the table is
  believed in both directions: an absent row reads as "not scheduled yet" — including in
  `speaker-calendar-invites.ts`, which skips such a session **without** adding it to `unreachable`,
  so an organizer pressing Send is shown zero invitations sent and zero problems found — and a row
  that should not be there reads as a real placement, at whatever hour it happens to name.

  Two ways the table could diverge, neither observed and neither currently detected. First, the
  deploy window: `npm run deploy` runs `migrate:remote` before it uploads the Worker, so for the
  length of a web build the old Worker is still serving and still commits publications without
  maintaining the new table; a publication landing in that window desynchronises that event.

  Be precise about what does and does not recover, because the reassuring half is the smaller
  half. The **times** do recover, and structurally: `publish` deletes the event's rows and
  re-derives every one of them from the new publication's board alone, so no stale hour survives a
  later publication. The **revision** does not. It is folded forward from whatever row was there,
  so a missed publication leaves it either lower or higher than the replay would have produced —
  both directions occur — until some later publication changes that session's triple and
  resynchronises it.

  The table diverges along two axes, not one, and it is worth separating them because they fail
  in opposite directions.

  *Which row exists.* A publication that unplaces a session makes the correct table drop its row;
  the missed one leaves the row standing. Nothing downstream re-checks the row against the board
  in force — `publishedSessionSchedules` hands the table's contents straight back — so a session
  the published programme no longer schedules still reads as scheduled, at the hour it used to
  hold. A Send then computes a ref that differs from the stored one, allocates a new SEQUENCE, and
  mails the speakers an invitation to a session that is not on the programme. The correct table
  skips that session entirely and mails nothing, so this is strictly *more* mail than a correct
  table sends, and every message of it is wrong.

  *What the revision says.* Here the drift is bounded: both the stored ref and the ref a Send
  computes come from this same table, so the comparison never sees the replay's numbering, and
  removing a publication cannot add a change point to a session that stays placed throughout. For
  such a session a stale revision therefore changes the numbering without changing the mail. What
  it can do is *suppress*, and that is the failure #136 exists to prevent: a session placed at v1
  and invited with `scheduleRef` `1|…`; the missed publication at v2 unplaces it, so a correct
  table drops the row while the stale one keeps `revision 1`; v3 places it back at the identical
  time. The replay would say `revision 3` — absence resets — and send the REQUEST that puts the
  talk back on the speaker's calendar. The desynchronised table computes "unchanged", keeps
  `revision 1`, matches the ref already in `calendar_invite_states`, and sends nothing. The
  `legacyMatch` branch does not rescue it: that arm requires a stored ref with no `<digits>|`
  prefix, and this one has one, so the `scheduleRevisedAt` comparison behind it is never reached.

  So a single missed publication can both send mail it should not and withhold mail it should,
  depending on which session you look at. Any claim that the drift is one-directional is wrong;
  an earlier revision of this entry made it in both directions before this one settled.

  Be equally precise about the harm in that suppression case, which is narrower than "the talk
  vanishes". Nothing here emits an iTIP `CANCEL` — `buildSpeakerInvite` only ever produces
  `REQUEST` — so the v1 entry is still on the speaker's calendar, at the right hour, because a
  suppressed resend requires the time to be identical. What is lost is the re-affirming REQUEST.
  That matters for exactly the
  speakers who no longer hold the entry: one who deleted it while the session was unplaced, which
  is the very scenario the absence-resets rule exists for, and one whose original invitation never
  arrived. For them the talk is missing, no repeat of Send will put it back — the stale ref keeps
  comparing equal however many times it runs — and the organizer is told everything was fine. It
  takes one of the repairs below to make a later Send deliver it.

  Second, the invariant that every writer of
  `agenda_publications` also maintains `agenda_session_schedules` is convention, not a constraint —
  the only writers of production data are `D1AgendaRepository.publish` and the seed, and both do,
  but a future import or repair path that inserts a publication directly would desynchronise
  silently. Test fixtures already insert publications directly and deliberately do not maintain
  the table — that is how the backfill is tested — so the convention is one nothing enforces even
  today.
  Related: nothing checks that a publication's version is the event's newest before rewriting the
  table, which is unreachable through `AgendaService.publish` (it allocates `max + 1`) but not
  through such a path.

  Owner: agenda. Governing IDs: `PRD-AGD-001`, `PRD-SPK-002`. Closure: either a reconciliation that
  can detect and repair divergence — a per-event watermark compared against `MAX(version)`, replayed
  once when it lags — or a trigger on `agenda_publications` that makes an unmaintained insert
  impossible; plus a test that proves a desynchronised table is detected rather than served. Note
  that whichever is chosen has to cover **both** divergence axes above: a repair that only
  recomputes revisions for rows that exist would leave a phantom row inviting speakers to a session
  the programme does not schedule. A replay of the history rebuilds the row set as well as the
  numbers, which is why it is the safer shape.

  Until then, the operational mitigation is to avoid the window rather than to repair it: do not
  deploy while an organizer may be publishing. Republishing the same board afterwards is **not** a
  repair — an identical board compares equal and folds the stale `revision` straight through, so
  the one number that matters is the one it does not restore. Two things do work, and the
  difference between them is not what they mail to whom, because neither publishing nor row
  surgery sends a calendar invitation at all: `SpeakerCalendarInviteService.send` is reached only
  from the organizer's explicit Send. What each costs is this. Publishing the session to a
  different hour and back resynchronises the revision, because both folds then derive it from the
  publication that moved it — but it is two publications, so it emits two `EVT-SCHEDULE-PUBLISHED`
  records, and each fans out to one `schedule-published` email per speaker **on the whole event**,
  not merely the affected one; it also leaves the published programme naming the wrong hour in
  between. Correcting the row in `agenda_session_schedules` against a replay of
  `agenda_publications` restores the replay's exact number, mails nobody, and moves no programme,
  which is why it is preferable wherever database access is available. Either way the speakers who
  lost the entry get it back at the next Send, which is the point of repairing at all.
- `GAP-022` **Search opens the surface a record lives on, not the record, and its cost is proven
  bounded only against the seed.** Six limits, all deliberate, all worth naming rather than
  discovering: two about search, two about the audit timeline, two about the inbox.

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

  Programme inbox dismissal keys carry no occurrence. The agenda projection names the conflict
  or unplaced session but exposes no board revision or occurrence, so resolving and then exactly
  recreating that condition derives the same key and leaves it dismissed. Other categories carry
  the deadline, attempt, or publication state that changes when their condition recurs.

  Owner: platform. Governing ID: `PRD-OPS-001`, `PRD-OPS-002`, `PRD-OPS-003`, `ACC-OPS`.

  Six limits, six closures, each independent of the others. A record-addressable route on at
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
  its test is an inbox that shows a failure older than one page of history. An agenda-owned
  monotonic board revision or occurrence on each derived programme condition, carried into the
  platform key and covered by a resolve-then-recreate test, closes the sixth.
