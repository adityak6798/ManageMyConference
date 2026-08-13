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

- `GAP-007` **Partially closed by issue #60, and further by Google sign-in.** Production has
  emailed-code sign-in, event-scoped bearer tokens, and now Google OIDC beside them — an additional
  provider, never a replacement — with provider linking on the stable provider subject and, failing
  that, on a **verified** address only. Two of the items this entry used to list are closed: the
  approved provider ADR exists at
  [`ADR-004`](../decisions/adr-004-google-oauth-provider.md), and `POST /api/auth/signout` exists.
  Demo impersonation remains development-only.

  **Durable revocation is closed.** An issued session is a row in `identity_sessions`, the cookie
  names it, and every authenticated request refuses a credential whose row is missing, revoked or
  expired. `POST /api/auth/signout` marks the row revoked before clearing the cookie and
  `POST /api/auth/sessions/revoke-all` ends every live session of one user, so a copy taken from
  another device — and an event bearer token minted from that session, which carries its parent's
  `sid` — stop being accepted on the next request. A token minted before this change names no row
  and is refused, which signs everybody out once at that deploy.
  [`ADR-005`](../decisions/adr-005-durable-sessions-and-revocation.md) records the design.

  **The identity audit spine exists and is deliberately narrow.** `identity_audit_events` is
  append-only, carries no credential, and every writer batches its row with the state change it
  describes. Today only the three `session.*` actions are written. The Google callback's refusals
  are *not* audited and stay in the structured log `auth.google.refused`, for the reason `ADR-005`
  gives: a refusal has no state change to batch a row with. Issue #99 owns the cross-domain audit
  timeline; this lane builds none, and the columns are shaped so #99 can project them without a
  migration.

  **Membership administration exists.** `MembershipService` and the
  `/api/organizations/{organizationId}/…` routes invite into an organization or onto one of its
  events, accept by the accepting session's own identity, remove members, grant and revoke event
  roles, and serve the organization's own audit log; the console surface is `/members`. All three
  demo-safety rules in [authorization](../architecture/authorization.md) are enforced and proved
  by test. Authorization is the three-condition organization pattern the CRM directory uses, on a
  new event-earned `identity:manage` capability rather than a global administrator role.

  **Credential rotation and recovery is what remains.** No `SESSION_SECRET` rotation path exists,
  so rotating today invalidates every session instantly; and there is no documented procedure for
  it, for `GOOGLE_CLIENT_SECRET`, or for incident revocation. Owner: identity-access. Governing
  IDs: `PRD-IAM-001`, `ARC-AUTH-001`, `ADR-004`, `ADR-005`. Closure: dual-secret verification with
  a documented rotation window, an incident revocation tool, and a security-operations runbook
  covering provider configuration, key rotation, incident revocation and recovery.
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
