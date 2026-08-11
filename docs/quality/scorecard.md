# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-11 (working tree: commit `4a46216`)

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

Everything below was run on 2026-08-11, in this order, against the working tree this document
describes. The browser commands name ports `4373`/`9087` because another checkout on this machine was
holding the defaults, and Playwright silently tests whatever already answers on the port it wants
(`GAP-004`).

| Command | Result |
|---|---|
| `npm run check` | exit 0 — `gate:integrity` (gate drift over 5 gates, Biome/Ruff format, `greenroom-context check`, Python CLI tests, lint + AST error policy, typecheck, OpenAPI drift, declared-schema drift over 34 tables and 21 migrations), then `gate:test-build` (38 `node --test` tool tests; 133 tests in 17 files in `@greenroom/api`; 93 tests in 12 files in `@greenroom/web`; both production builds), then `gate:d1` (20 tests in 11 files) |
| `npm run reset`, then `GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e` | 30 passed (27.9s). This is the clean-reset run |
| the same `npm run test:e2e` a second time, no reset, against the same still-running servers | 30 passed (27.6s) |
| the same `npm run test:e2e` a third time, still no reset | 30 passed (28.1s) |
| `GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:quality` | 3 passed (2.2s) |
| `npm run gate:security` | **not run in this measurement.** `npm audit` last succeeded on hosted CI at head `10eab436` |
| gitleaks | **not runnable locally.** It is a marketplace action; it succeeded in the `security` job of run `31471037575` at head `10eab436` |

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

## Acceptance rows

| Acceptance ID | Journey | Verdict (local) | Automated evidence | Not covered by this row |
|---|---|---|---|---|
| `ACC-HARNESS` | reference slice | shipped | `tools/tests/check-errors.test.mjs`, `check-gate-drift.test.mjs`, `check-schema-drift.test.mjs`, `tools/tests/test_context.py`; `apps/api/test/http.test.ts`, `demo-session.test.ts`, `runtime-auth.test.ts`, `event-service.test.ts`, `event-mappers.test.ts`, `d1-event-repository.integration.test.ts`; `apps/web/test/router.test.tsx`, `error-fallback.test.tsx`. **No browser spec carries this marker** — an earlier version of this row cited `apps/web/e2e/reference-slice.spec.ts`, which carries `ACC-IDENTITY-EVENTS` and `ACC-AGENDA` | Branch protection is **not enabled**: `gh api repos/:owner/:repo/branches/main/protection` answered 404 "Branch not protected" on 2026-08-11, so the five CI jobs are not required checks (`GAP-003`) |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | shipped | `apps/web/e2e/reference-slice.spec.ts`; `apps/web/test/App.test.tsx`; `apps/api/test/d1-identity-directory.integration.test.ts`, plus the session and authorization tests listed under `ACC-HARNESS` | There is **no production authentication**. Signed, expiring demo-mode cookies are the only identity path and the API refuses demo mode outside development, which means a deployed instance is either 401-only or fully impersonatable (`GAP-007`, issues #60, #12). Nothing serves the built frontend against a configurable API origin (`GAP-008`, issue #61) |
| `ACC-REVIEW` | `JNY-003` | shipped | `apps/api/test/review-service.test.ts`, `review-http.test.ts`, `content-http.test.ts`, `d1-review-repository.integration.test.ts`; `apps/web/test/proposal-acceptance.test.tsx`; `apps/web/e2e/review-workflow.spec.ts`, `lifecycle.spec.ts` | Review is single-round and has no AI assistance, while `PRD-AI-001` and `PORT-AI` are documented as if a port existed (`GAP-011`, issue #57). Issue **#71 is fixed in this working tree and still open in the tracker**: `apps/web/src/ReviewWorkspace.tsx` renders an explicit `Not scored` option, and `review-workflow.spec.ts` ("a reviewer scores and declares a conflict…") asserts that completing without scores is refused with an alert naming "Relevance, Clarity" and that the queue still reads `Not started`. The fix arrived with pull request #88 — which claims the issue, is still open, and is not on `main` — so no merged commit carries it |
| `ACC-CFP` | `JNY-001`, `JNY-002` | shipped | `apps/api/test/cfp-service.test.ts`, `cfp-http.test.ts`, `d1-cfp-repository.integration.test.ts`, `seed-state.integration.test.ts`; `apps/web/test/cfp-composer.test.tsx`; `apps/web/e2e/00-seed-state.spec.ts`, `cfp.spec.ts`, `lifecycle.spec.ts` | Fields are typed, ordered, and required-or-not; there is **no conditional field logic and no category-based routing** (`GAP-009`, issue #49), which is why brief feature 1 is *partial* while this journey is shipped. The seed defect this row once hid — a published snapshot with no `fields`, which rendered an empty public form and answered 500 — is now asserted before any spec can repair it, by `apps/web/e2e/00-seed-state.spec.ts` and `apps/api/test/seed-state.integration.test.ts` |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | shipped | `apps/api/test/content-service.test.ts`, `content-http.test.ts`, `d1-content-repository.integration.test.ts`; `apps/web/test/speaker-photo.test.tsx`, `proposal-acceptance.test.tsx`; `apps/web/e2e/speaker-portal.spec.ts`, `lifecycle.spec.ts` | **Issue #62 is closed.** Its headshot criteria are asserted end to end: `speaker-portal.spec.ts` uploads a real 1×1 PNG in the portal, names it the profile photo, has an organizer mark that file publishable and publish, then loads `/events/greenroom-demo-summit/speakers` in a fresh `browser.newContext()` with no session and asserts the tile's `img.pub-avatar` actually decoded bytes (`naturalWidth > 0`) — and then, after the organizer returns that file to private and republishes, that the tile falls back to the `SS` monogram. Its second criterion is met by a download control on every row of the organizer asset table; the same spec clicks it and asserts the delivered file's PNG magic bytes, so a link pointing at nothing would fail. Naming a headshot is deliberately not publishing it, so a private file chosen as the profile photo stays invisible until an organizer marks it publishable. Beyond #62: the calendar is a **download**, not an invite delivered to a speaker's own calendar (`GAP-010`, issue #56); there are **no resource or wiki pages** in the portal (`GAP-013`, issue #54); organizer "communications" recorded here are log rows, not sends (`GAP-010`, issues #52, #66); and the Overview dashboard this journey feeds has no assertion on its rows (`GAP-015`) |
| `ACC-CRM` | `JNY-008` | shipped | `apps/api/test/crm-service.test.ts`, `crm-http.test.ts`, `d1-crm-repository.integration.test.ts`, `d1-speaker-conversion.integration.test.ts`; `apps/web/test/crm-owner-assignment.test.tsx`; `apps/web/e2e/crm.spec.ts` | Durable speaker-conversion claim rows left behind by a permanently failed workflow have no reconciliation or alerting (`DEBT-004`) |
| `ACC-AGENDA` | `JNY-006` | shipped | `apps/api/test/agenda-service.test.ts`, `d1-agenda-repository.integration.test.ts`; `apps/web/test/agenda-timeslots.test.tsx`, `agenda-timezone.test.tsx`; `apps/web/e2e/agenda.spec.ts`, `reference-slice.spec.ts`, `lifecycle.spec.ts` | `EVT-SCHEDULE-PUBLISHED` is specified but no durable outbox emission exists, so publication is not yet transactional with its event (`DEBT-006`, issue #22) |
| `ACC-PUBLIC` | `JNY-007` | shipped | `apps/api/test/publication.test.ts`, `d1-publication-repository.integration.test.ts`, `seed-state.integration.test.ts`; `apps/web/test/publishing.test.tsx`, `public-event-pages.test.tsx`; `apps/web/e2e/public-event.spec.ts`, `publishing.spec.ts`, `00-seed-state.spec.ts`, `lifecycle.spec.ts`; and the public-route smoke in `lifecycle-demo.spec.ts` (`npm run test:quality`), which carries the `ACC-DEMO-SMOKE` marker rather than this one | The row's old caveat — that the seeded projection was hand-written fixture data, so publishing replaced the page with different content — is closed: `apps/api/test/d1-publication-repository.integration.test.ts` applies the seed in Miniflare and asserts the composed preview equals the seeded snapshot field for field, then republishes and asserts the public page is unchanged (issues #36, #63). Accessibility evidence is a **hand-rolled smoke on one page** — heading order, landmarks, control labelling, 390px overflow. There is no automated ruleset, no contrast check and no focus-order check (`GAP-014`, issue #48). The "budgets" it also checks are one DOMContentLoaded under 10 s and fewer than 100 resource requests, measured against the Vite dev server, so they bound very little and nothing at all about a built artifact (`GAP-014`, issue #84) |
| `ACC-INTEGRATION` | `JNY-009` | partial | `apps/api/test/communications-service.test.ts`, `communications-http.test.ts`, `d1-communications-repository.integration.test.ts`; `apps/web/test/communications.test.tsx`; `apps/web/e2e/communications.spec.ts` | The journey is partial because a step of it has no implementation to exercise: **no lifecycle event enqueues anything**, and the only provider wired into the Worker is the deterministic success fake, so the seeded history is placeholder data and no message content has ever been rendered by a product trigger (`GAP-010`, issues #52, #66, #82). **Accelevents is an enum value with no integration behind it** (`GAP-012`, issue #58); production provider adapters do not exist (issue #23). The browser half is also weaker than it looks: `communications.spec.ts` branches on fixture state (`GAP-005`), and recovering the terminal delivery consumes its own precondition, so **only the first run after a reset exercises recovery** — in the measurement above, run 1 of 2; run 2 asserted the complement (already queued, no retry control, route refuses). The claim that recovery is real rests on that one post-reset run plus the service, HTTP and D1 tests, not on the suite as a whole |
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
