# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-11 (working tree: commit `3630977`)

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
  by default). What remains is a provisioned preview/production target and its smoke and rollback
  gates; without those, deployability is locally verified but no hosted URL is evidenced. Owner:
  platform. Governing ID: `ENG-CI-001`. Closure: provision the target, run public/embed/API smoke
  against its URL, and prevent promotion or roll back when that smoke fails.
- `GAP-009` **Brief feature 1 is incomplete**: the CFP form model has no conditional field logic and
  no category-based routing. Impact: the feature's two named differentiators are absent while the
  rest of the CFP is shipped. Owner: cfp. Governing ID: `PRD-CFP-001`, `ACC-CFP`. Closure: issue #49
  — conditions expressible in the persisted model, honoured by the applicant renderer *and* server
  validation, with a submission visibly routed to a status or category.
- `GAP-010` **Brief feature 3 is incomplete**: no lifecycle event enqueues a communication, the only
  provider wired into the Worker is the deterministic success fake, organizer "communications" in the
  content workspace are log rows rather than sends, and the speaker calendar is a download rather
  than an invite delivered to Gmail/Outlook/iCal. Impact: the seeded outbox is placeholder data and
  no message content has ever been produced by a product trigger. Owner: communications-integrations.
  Governing ID: `PRD-COM-001`, `PRD-SPK-002`, `ACC-INTEGRATION`. Closure: issues #52, #66, #82
  (trigger, send, assert rendered content in the browser), #56 (calendar delivery), #23 (production
  adapters).
- `GAP-011` **Brief feature 4 is incomplete**: review is single-round and has no AI assistance, while
  `PRD-AI-001` and the `PORT-AI` entry in [integration architecture](../architecture/integrations.md)
  read as though a port existed. Impact: the documentation currently claims more than the code does.
  Owner: review. Governing ID: `PRD-REV-001`, `PRD-AI-001`, `ACC-REVIEW`. Closure: issue #57 — either
  a multi-round model plus an honest suggestion port with provenance and manual fallback, or the
  removal of the AI claims from the architecture docs.
- `GAP-012` **Brief feature 7 is missing**: Accelevents is a delivery-channel enum value with the
  deterministic fake behind it. There is no client, fixture, field mapping, or organizer surface.
  Impact: a named brief feature has zero implementation while `PRD-INT-001` names the provider.
  Owner: communications-integrations. Governing ID: `PRD-INT-001`, `ACC-INTEGRATION`. Closure: issue
  #58 — a fixture-backed one-way sync with a visible organizer surface, or documentation that says
  plainly it is not implemented.
- `GAP-013` **Brief feature 8 is missing**: the speaker portal has no resource or wiki pages and no
  sanitized HTML embed support — it carries tasks, profile, uploads, headshot selection and a
  calendar download, and nothing to read. Impact: speakers have nowhere to read reference material
  the brief expects the portal to carry. Owner: content. Governing ID: `PRD-SPK-002`, `ACC-SPEAKER`. Closure:
  issue #54 — organizer-authored pages, speaker-visible in the portal, with pasted reference HTML
  rendered through a sanitizer covered by its own tests.
- `GAP-014` The public accessibility evidence is a hand-rolled smoke on one page — heading order,
  landmarks, control labelling and 390px overflow — with no automated ruleset, contrast check, or
  focus-order check; and what is called a performance budget is two ceilings on
  `/events/greenroom-demo-summit` — DOMContentLoaded under 10 seconds and fewer than 100 resource
  requests — measured against the Vite dev server. Impact: `ACC-PUBLIC`'s accessibility and
  performance claims are narrower than the words "accessible" and "budget" suggest; those two numbers
  would catch a page that never finished loading or an accidental hundred-request waterfall and
  nothing subtler, and they bound nothing about a built artifact. Owner: quality. Governing ID:
  `ACC-PUBLIC`, `TST-006`. Closure: issues #48 and #84 — an automated ruleset across more than one
  page, and budgets measured against `vite preview` or a deployed artifact.
- `GAP-015` **Brief feature 6 has no assertion on its rows.** The Overview dashboard renders each
  speaker with outstanding onboarding work, their task, due date and days overdue, but
  `apps/web/e2e/lifecycle-demo.spec.ts` asserts only that the heading renders and the jsdom test
  feeds the page an empty payload. It is also request-scoped rather than pushed, so "real-time" means
  "current as of the last load". Impact: a regression in the one surface this feature is judged on
  would pass every gate. Owner: quality. Governing ID: `ACC-SPEAKER`, `TST-006`. Closure: a browser
  assertion that a seeded speaker with an open task appears in the table with their due date, and an
  explicit decision on whether live updates are in scope.
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
  noise. Owner: platform. Governing ID: `ENG-DEV-001`, `ACC-DEMO-SMOKE`. Closure: the suite fails
  with a diagnosis rather than 22 misleading assertion errors — a `webServer` health probe between
  spec files, or a Playwright global setup that fails fast when the API stops answering — and the
  wrangler crash itself is reported upstream with the log from `apps/api/.wrangler/wrangler.log`.
