# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-11

The commit each verdict was measured against is **not written here**. It lives in the run records
under `.evidence/`, which is where `gate:evidence` reads it, and duplicating it in this header is
how it went stale before: a hand-copied SHA has no gate behind it and drifts on the next commit.
Run `npm run gate:evidence` to see the head every row is currently bound to.

## How to read this

A row states what is **proven by automated tests in this repository, measured locally**, and names
what is still missing behind it. "Done" in this repository requires behaviour, negative
authorization, visible error state, observability, automated acceptance, documentation linkage, and
clean CI. No row below satisfies the last of those, so no row says "done".

Three terms are used precisely:

- **Local** — measured on a developer machine by one of the commands in
  [what was measured](#what-was-measured), on the date that section names. Every verdict here is
  local.
- **Hosted CI** — a GitHub Actions run whose conclusion can be inspected. **No hosted CI run exists
  for any commit on this branch.** The most recent green run of all five jobs (`integrity`,
  `test-build`, `d1`, `browser`, `security`) is run `31471037575` at head `10eab436`. That head and
  this branch are **divergent** — neither is an ancestor of the other, so the branch is neither
  "ahead of" nor "behind" it. Measured on 2026-08-11: `git merge-base HEAD 10eab436` answers
  `fd21987`, and `git rev-list --left-right --count 10eab436...HEAD` answers one commit on the run's
  side and five on this branch's. The green run carries one commit this branch does not have
  (`10eab43`, the last commit of pull request #88, from whose branch this one was cut one commit
  earlier), and this branch carries five commits that run never saw. Treat hosted CI as pending, not
  as passed.
- **Verdict (local)** — a statement about the **journey** the row names, not about the competition
  feature that journey serves. *shipped* means every step of that journey is exercised by an
  automated test on this machine; *partial* means a step of it has no automated exercise, or has no
  implementation to exercise. A journey can be shipped while the brief feature it serves is partial —
  `ACC-CFP` and `ACC-REVIEW` are exactly that — because feature completeness is a different
  question, answered in its own column in the
  [traceability table](../product/competition-traceability.md).

## What was measured

Everything below was run on 2026-08-11, in this order, against the commit this document names.
Each run wrote a record under `.evidence/`, and `gate:evidence` refuses these rows if a record is
missing, failed, or was produced against a different commit — so the numbers here are checkable
rather than asserted.

The browser commands used to name ports `4373`/`9087` because another checkout on this machine
was holding the defaults. They no longer need to: ports are derived per checkout, and a server
belonging to a different one aborts the run instead of being silently tested (`GAP-004`,
issues #28 and #90).

| Command | Result |
|---|---|
| `npm run check` | exit 0 — `gate:integrity` (gate drift over 6 gates, Biome/Ruff format, `greenroom-context check`, Python CLI tests, lint + AST error policy, typecheck, OpenAPI drift, declared-schema drift over 34 tables and 22 migrations), then `gate:test-build` (376 tests across the `node --test` tool suite, `@greenroom/api` and `@greenroom/web`, plus both production builds), then `gate:d1` (28 tests in 12 files), then `gate:evidence` |
| `npm run gate:browser` (`setup:local`, production web build, `reset`, then the suite) | 30 passed, on derived ports with no manual port assignment. This is the clean-reset run; building first also proves Wrangler can serve the production frontend artifact from a clean checkout |
| `npm run test:e2e` again against the same still-running servers | 30 passed — re-runnable on one fixture without a reset |
| `npm run test:quality` | 3 passed |
| `npm run gate:security` | exit 0 — `npm audit --audit-level=high` found 0 vulnerabilities |
| gitleaks | **not runnable locally.** It is a marketplace action; it succeeded in the `security` job of run `31471037575` at head `10eab436` |

The earlier measurement of two `wrangler dev` instances of one worktree corrupting each other —
2 failures across 5 runs, a different spec each time — is **no longer reproducible and is not
re-stated as current**: local D1 and R2 state is now keyed per instance, so the two processes no
longer share a database (issue #28). The record of why that changed is in
[known gaps](known-gaps.md) under `GAP-004`.

**No row below has its own command, because no such command exists.** An earlier version of this
table gave each row an `npm run test:e2e … -- e2e/<one>.spec.ts` line and called it that row's
clean-reset reproduction. That was wrong twice over: none of those commands had been run, and a
single-spec invocation is not equivalent to the evidence above. The browser specs share one mutable
local D1 fixture at `workers: 1` and are deliberately order-dependent — `00-seed-state.spec.ts` is
named to sort first precisely so that `cfp.spec.ts` cannot repair the seed before it is asserted —
and outside CI Playwright reuses any server already answering, so a single-spec run against running
servers performs **no reset at all**. Measured on 2026-08-11, this command:

```bash
GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e --workspace @greenroom/web -- e2e/agenda.spec.ts
```

passed 6 tests in 5.4s against the already-running servers and the fixture the two full runs above
had left behind, resetting nothing. It is a debugging tool. What reproduces a row is the whole suite
from a reset, in the order above.

The **Automated evidence** column therefore names the test files that carry each row's `@acceptance`
marker. Each of them is run by `npm run check` (tool, API, and component suites), by `npm run test:d1`
(`*.integration.test.ts`), or by the full `npm run test:e2e` (`e2e/*.spec.ts`).

## What makes a row here checkable

Every verdict below is bound to a run, not asserted in prose.
[`acceptance-evidence.json`](acceptance-evidence.json) states, per row, which suites it rests on
and which spec files carry its marker; each suite writes a record under `.evidence/` naming its
exit status, counts, and the commit it ran against; and `npm run gate:evidence` — the fourth gate
in `npm run check` — fails a row whose suite has no record, has a record from a different commit,
has a record of a failing run, or names a spec file that no longer exists.

That last rule exists because of a specific failure. `ACC-AGENDA` claimed complete Playwright
evidence for the agenda resource editor in the same change that deleted its only browser
coverage (#87), and nothing connected the two. It is now a build failure. So is the older and
more expensive case: the `ACC-CFP` row read "passed locally 2026-08-10 … complete" while every
public proposal submission returned 500 from a clean reset, and the row is *why* the defect
survived — the documentation said the journey worked.

The freshness rule is deliberate and narrow: a record counts only for the commit it names.
A suite that passed on other code is not evidence about this one. It does **not** detect
uncommitted working-tree changes — the binding is to `HEAD`, not to a tree hash — so a record
made before an edit still satisfies the gate until the next commit. Producing evidence is
therefore the last step before publishing, not the first.

## Acceptance rows

| Acceptance ID | Journey | Verdict (local) | Automated evidence | Not covered by this row |
|---|---|---|---|---|
| `ACC-HARNESS` | reference slice | shipped | `tools/tests/check-errors.test.mjs`, `check-gate-drift.test.mjs`, `check-schema-drift.test.mjs`, `tools/tests/test_context.py`; `apps/api/test/http.test.ts`, `demo-session.test.ts`, `runtime-auth.test.ts`, `event-service.test.ts`, `event-mappers.test.ts`, `d1-event-repository.integration.test.ts`; `apps/web/test/router.test.tsx`, `error-fallback.test.tsx`. **No browser spec carries this marker** — an earlier version of this row cited `apps/web/e2e/reference-slice.spec.ts`, which carries `ACC-IDENTITY-EVENTS` and `ACC-AGENDA` | Branch protection is **not enabled**: `gh api repos/:owner/:repo/branches/main/protection` answered 404 "Branch not protected" on 2026-08-11, so the five CI jobs are not required checks (`GAP-003`) |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | shipped | `apps/web/e2e/reference-slice.spec.ts`; `apps/web/test/App.test.tsx`; `apps/api/test/d1-identity-directory.integration.test.ts`, `real-auth.test.ts`, plus the session and authorization tests listed under `ACC-HARNESS` | Emailed-code production sign-in and event-scoped bearer tokens are implemented by issue #60. Durable logout/revocation, rotation/recovery operations, membership administration, audit events, and the provider ADR remain in `GAP-007` / issue #12. A hosted smoke remains in `GAP-008` |
| `ACC-REVIEW` | `JNY-003` | shipped | `apps/api/test/review-service.test.ts`, `review-http.test.ts`, `content-http.test.ts`, `d1-review-repository.integration.test.ts`; `apps/web/test/proposal-acceptance.test.tsx`; `apps/web/e2e/review-workflow.spec.ts`, `lifecycle.spec.ts` | Review is single-round and has no AI assistance, while `PRD-AI-001` and `PORT-AI` are documented as if a port existed (`GAP-011`, issue #57). Issue **#71 is fixed in this working tree and still open in the tracker**: `apps/web/src/ReviewWorkspace.tsx` renders an explicit `Not scored` option, and `review-workflow.spec.ts` ("a reviewer scores and declares a conflict…") asserts that completing without scores is refused with an alert naming "Relevance, Clarity" and that the queue still reads `Not started`. The fix arrived with pull request #88 — which claims the issue, is still open, and is not on `main` — so no merged commit carries it |
| `ACC-CFP` | `JNY-001`, `JNY-002` | shipped | `apps/api/test/cfp-service.test.ts`, `cfp-http.test.ts`, `d1-cfp-repository.integration.test.ts`, `seed-state.integration.test.ts`; `apps/web/test/cfp-composer.test.tsx`; `apps/web/e2e/00-seed-state.spec.ts`, `cfp.spec.ts`, `lifecycle.spec.ts` | Conditional visibility and category-based status routing are persisted and enforced on both client and server; resolved routes survive form edits in the submission snapshot (`GAP-009` closed by issue #49). Editable draft saves compare the loaded version atomically, preserve the winning draft on conflict, and offer an explicit reload path (issue #20). The seed defect this row once hid — a published snapshot with no `fields`, which rendered an empty public form and answered 500 — remains asserted before any spec can repair it, by `apps/web/e2e/00-seed-state.spec.ts` and `apps/api/test/seed-state.integration.test.ts` |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | shipped | `apps/api/test/content-service.test.ts`, `content-http.test.ts`, `content-resource-sanitizer.test.ts`, `content-csv-import.test.ts`, `content-deliverables.test.ts`, `d1-content-repository.integration.test.ts`; `apps/web/test/speaker-photo.test.tsx`, `proposal-acceptance.test.tsx`; `apps/web/e2e/speaker-portal.spec.ts`, `lifecycle.spec.ts` | Issue #62's headshot criteria remain asserted end to end. Issues #54 and #94 add organizer-authored sanitized resource pages, CSV preview/import with explicit invalid and duplicate rows, persistent workflow/custom fields, bulk dated tasks, task-associated versioned uploads with readable prior versions, attributed cross-role comments, attributed profile/session revisions with restore, and deterministic latest-only ZIP download. Calendar delivery and overdue notification remain communications-owned work in issues #52/#66/#82; content creates no delivery rows and calls no communications surface. |
| `ACC-CRM` | `JNY-008` | shipped | `apps/api/test/crm-service.test.ts`, `crm-http.test.ts`, `d1-crm-repository.integration.test.ts`, `d1-speaker-conversion.integration.test.ts`; `apps/web/test/crm-owner-assignment.test.tsx`; `apps/web/e2e/crm.spec.ts` | Durable speaker-conversion claim rows left behind by a permanently failed workflow have no reconciliation or alerting (`DEBT-004`) |
| `ACC-AGENDA` | `JNY-006` | shipped | `apps/api/test/agenda-service.test.ts`, `agenda-http.test.ts`, `d1-agenda-repository.integration.test.ts`; `apps/web/test/agenda-timeslots.test.tsx`, `agenda-timezone.test.tsx`, `agenda-assisted-placement.test.tsx`; `apps/web/e2e/agenda.spec.ts`, `reference-slice.spec.ts`, `lifecycle.spec.ts` | Publication is transactional, its versions are allocated per attempt, and a retried command replays through `Idempotency-Key` rather than freezing a second version, so concurrent publishes are distinct and monotonic and a failed publication leaves neither snapshot nor event. `EVT-SCHEDULE-PUBLISHED` is derived from every committed publication but no writer is bound to the seam yet, so it is not durably stored (`DEBT-006`, issue #22) |
| `ACC-PUBLIC` | `JNY-007` | shipped | `apps/api/test/publication.test.ts`, `d1-publication-repository.integration.test.ts`, `seed-state.integration.test.ts`; `apps/web/test/publishing.test.tsx`, `public-event-pages.test.tsx`; `apps/web/e2e/public-event.spec.ts`, `publishing.spec.ts`, `00-seed-state.spec.ts`, `lifecycle.spec.ts`; and the public-route smoke in `lifecycle-demo.spec.ts` (`npm run test:quality`), which carries the `ACC-DEMO-SMOKE` marker rather than this one | The row's old caveat — that the seeded projection was hand-written fixture data, so publishing replaced the page with different content — is closed: `apps/api/test/d1-publication-repository.integration.test.ts` applies the seed in Miniflare and asserts the composed preview equals the seeded snapshot field for field, then republishes and asserts the public page is unchanged (issues #36, #63). Accessibility evidence is a **hand-rolled smoke on one page** — heading order, landmarks, control labelling, 390px overflow. There is no automated ruleset, no contrast check and no focus-order check (`GAP-014`, issue #48). The "budgets" it also checks are one DOMContentLoaded under 10 s and fewer than 100 resource requests, measured against the Vite dev server, so they bound very little and nothing at all about a built artifact (`GAP-014`, issue #84) |
| `ACC-INTEGRATION` | `JNY-009` | partial | `apps/api/test/communications-service.test.ts`, `communications-public.test.ts`, `communications-template.test.ts`, `communications-http.test.ts`, `provider-contract.test.ts`, `provider-configuration.test.ts`, `d1-communications-repository.integration.test.ts`; `apps/web/test/communications.test.tsx`, `communications-compose.test.tsx`; `apps/web/e2e/communications.spec.ts` | An organizer can now write a template and send it to the event's speakers from the console, and each speaker gets their own delivery carrying the message rendered from the pinned template version — proven by `communications-compose.test.tsx` (count, confirmation, refusal, rendered body on screen) and the service/HTTP tests. Live email, Airtable and Accelevents adapters exist behind the provider port and normalize success, retry, malformed and terminal outcomes identically (`provider-contract.test.ts`); `fixture` remains the default and a half-configured `live` throws rather than falling back to a fake — in the scheduled drain, not at startup, so such a deployment serves requests and simply never sends. **Still unproven, and each is a real gap.** No lifecycle event enqueues anything — acceptance, task creation and agenda publication remain silent, so the seeded history is still placeholder data (`GAP-010`, issues #66, #82, deferred to wave 3). **No live adapter has ever exchanged a request with its real API**: no credential exists in this repository, the contract suite stubs `fetch`, and the staging smoke in `docs/engineering/communications-providers.md` is written up but **has not run** — the suite proves our normalization, not their APIs, and Accelevents is the least certain of the three (`GAP-012`, issue #58). Reminder rules (issue #52's third scope bullet) are not implemented: they need content's task data and were deferred with #66. The browser half is unchanged and still weaker than it looks: `communications.spec.ts` asserts the four seeded rows and branches on fixture state (`GAP-005`), and recovering the terminal delivery consumes its own precondition, so **only the first run after a reset exercises recovery**. Nothing in the browser suite yet drives the new compose surface — that is #82's job |
| `ACC-DEMO-SMOKE` | evaluator orientation across `JNY-001`–`JNY-009` | shipped | `apps/web/e2e/lifecycle-demo.spec.ts` (the three tests `npm run test:quality` runs), `00-seed-state.spec.ts`, and the full suite from a reset | The suite is re-runnable but **not non-accumulating**: `publishing.spec.ts` leaves the event it creates, `review-workflow.spec.ts` files fresh abstracts, and `crm.spec.ts` adds a prospect on every run, so the fixture grows until `npm run reset` (`DEBT-007`). Hosted CI on this branch and the follow-ups owned by issue #10 remain open |

## What each row's automated evidence actually is

- Browser evidence is `apps/web/e2e/*.spec.ts`, one shared local D1 fixture, `workers: 1`.
  `apps/web/e2e/lifecycle.spec.ts` is the only spec that carries a single artifact across every
  boundary: public submission → triage → reviewer scoring → acceptance → readiness → agenda
  placement → schedule publication → site publication → public page and both embeds, then hands the
  fixture back.
- Component evidence is jsdom (`apps/web/test/*`). It stubs `fetch`, so a marker there proves
  rendering, never the pipeline. `apps/web/test/publishing.test.tsx` carries `ACC-PUBLIC` for that
  reason; `apps/web/e2e/publishing.spec.ts` is the half that touches the real API.
- API and domain evidence is `apps/api/test/*.test.ts`; D1 evidence is
  `apps/api/test/*.integration.test.ts`, run by `npm run test:d1` against Miniflare with every
  migration applied.
- Brief feature #6 — the outstanding-speaker-task dashboard — is the one shipped surface with no
  assertion on its rows. `apps/web/e2e/lifecycle-demo.spec.ts` asserts only that `Overview`
  renders; the jsdom test feeds it an empty payload. See `GAP-015`.

Where a row carries a gap, the gap is part of the record: it names what is not true yet and the
`GAP-*`/`DEBT-*` entry that owns it. Full detail is in [known gaps](known-gaps.md) and the
[technical debt register](../exec-plans/tech-debt.md); the feature-level picture is in
[competition traceability](../product/competition-traceability.md).
