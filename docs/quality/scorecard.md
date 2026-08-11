# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-11 (commit `c72b796`)

## How to read this

A row states what is **proven by a command in the [demo runbook](../demo-runbook.md), run from a
clean reset**, and names what is still missing behind it. "Done" in this repository requires
behaviour, negative authorization, visible error state, observability, automated acceptance,
documentation linkage, and clean CI. No row below satisfies the last of those, so no row says
"done".

Two words are used precisely:

- **Local** — reproduced on a developer machine by a named command. Every verdict below is local.
- **Hosted CI** — a GitHub Actions run whose conclusion can be inspected. **No hosted CI run
  exists for any commit on this branch.** The most recent green run of all five jobs
  (`integrity`, `test-build`, `d1`, `browser`, `security`) is run `31471037575` at head
  `10eab436`, which is *not* an ancestor of this branch — it is pull request #88, from which this
  branch was cut before five further commits landed. Treat hosted CI as pending, not as passed.

## Evidence measured on 2026-08-11 at commit `c72b796`

| Command | Result |
|---|---|
| `npm run check` | exit 0 — `gate:integrity` (gate-drift over 5 gates, Biome/Ruff format, `greenroom-context check`, Python CLI tests, lint + AST error policy, typecheck, OpenAPI drift, declared-schema drift over 34 tables and 21 migrations) then `gate:test-build` (37 `node --test` tool tests; 126 tests in 17 files in `@greenroom/api`; 88 tests in 11 files in `@greenroom/web`; both production builds) then `gate:d1` (20 tests in 11 files) |
| `GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e` | 30 passed. Run three times consecutively: once immediately after `npm run reset`, then twice more against the same already-running servers with no reset in between. All three green |
| `npm run test:quality` | 3 passed |
| `npm run gate:security` | **not run in this measurement.** `npm audit` last succeeded on hosted CI at head `10eab436` |
| gitleaks | **not runnable locally.** It is a marketplace action; it succeeded in the `security` job of run `31471037575` at head `10eab436` |

## Acceptance rows

| Acceptance ID | Journey | Verdict (local) | Reproduce it | Not covered by this row |
|---|---|---|---|---|
| `ACC-HARNESS` | reference slice | shipped | `npm run check`; `npm run test:e2e --workspace @greenroom/web -- e2e/reference-slice.spec.ts` | Branch protection is **not enabled**: `gh api repos/:owner/:repo/branches/main/protection` answered 404 "Branch not protected" on 2026-08-11, so the five CI jobs are not required checks (`GAP-003`) |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/reference-slice.spec.ts e2e/lifecycle-demo.spec.ts` | There is **no production authentication**. Signed, expiring demo-mode cookies are the only identity path and the API refuses demo mode outside development, which means a deployed instance is either 401-only or fully impersonatable (`GAP-007`, issues #60, #12). Nothing serves the built frontend against a configurable API origin (`GAP-008`, issue #61) |
| `ACC-REVIEW` | `JNY-003` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/review-workflow.spec.ts`; `npm run check` | Review is single-round and has no AI assistance, while `PRD-AI-001` and `PORT-AI` are documented as if a port existed (`GAP-011`, issue #57) |
| `ACC-CFP` | `JNY-001`, `JNY-002` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/00-seed-state.spec.ts e2e/cfp.spec.ts`; `npm run test:d1` | Fields are typed, ordered, and required-or-not; there is **no conditional field logic and no category-based routing** (`GAP-009`, issue #49). The seed defect this row once hid — a published snapshot with no `fields`, which rendered an empty public form and answered 500 — is now asserted before any spec can repair it, by `apps/web/e2e/00-seed-state.spec.ts` and `apps/api/test/seed-state.integration.test.ts` |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/speaker-portal.spec.ts e2e/lifecycle.spec.ts`; `npm run check` | The calendar is a **download**, not an invite delivered to a speaker's own calendar (`GAP-010`, issue #56). There are **no resource or wiki pages** in the portal (`GAP-013`, issue #54). Organizer "communications" recorded here are log rows, not sends (`GAP-010`, issues #52, #66) |
| `ACC-CRM` | `JNY-008` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/crm.spec.ts`; `npm run check` | Durable speaker-conversion claim rows left behind by a permanently failed workflow have no reconciliation or alerting (`DEBT-004`) |
| `ACC-AGENDA` | `JNY-006` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/agenda.spec.ts`; `npm run check` | `EVT-SCHEDULE-PUBLISHED` is specified but no durable outbox emission exists, so publication is not yet transactional with its event (`DEBT-006`, issue #22) |
| `ACC-PUBLIC` | `JNY-007` | shipped | `npm run test:e2e --workspace @greenroom/web -- e2e/public-event.spec.ts e2e/publishing.spec.ts e2e/00-seed-state.spec.ts`; `npm run test:d1`; `npm run test:quality` | The row's old caveat — that the seeded projection was hand-written fixture data, so publishing replaced the page with different content — is closed: `apps/api/test/d1-publication-repository.integration.test.ts` applies the seed in Miniflare and asserts the composed preview equals the seeded snapshot field for field, then republishes and asserts the public page is unchanged (issues #36, #63). Accessibility evidence is a **hand-rolled smoke on one page** — heading order, landmarks, control labelling, 390px overflow. There is no automated ruleset, no contrast check and no focus-order check (`GAP-014`, issue #48). The performance budget is measured against the Vite dev server, so it bounds nothing about a built artifact (`GAP-014`, issue #84) |
| `ACC-INTEGRATION` | `JNY-009` | partial | `npm run test:e2e --workspace @greenroom/web -- e2e/communications.spec.ts`; `npm run check` | The outbox, retry, terminal state, recovery and authorization behaviour are real, but **no lifecycle event enqueues anything** and the only provider wired into the Worker is the deterministic success fake, so the seeded history is placeholder data and no message content has ever been rendered by a product trigger (`GAP-010`, issues #52, #66, #82). **Accelevents is an enum value with no integration behind it** (`GAP-012`, issue #58); production provider adapters do not exist (issue #23) |
| `ACC-DEMO-SMOKE` | evaluator orientation across `JNY-001`–`JNY-009` | shipped | `npm run reset` then `npm run test:e2e`; `npm run test:quality` | The suite is re-runnable but **not non-accumulating**: `publishing.spec.ts` leaves the event it creates, `review-workflow.spec.ts` files fresh abstracts, and `crm.spec.ts` adds a prospect on every run, so the fixture grows until `npm run reset` (`DEBT-007`). Hosted CI on this branch and the follow-ups owned by issue #10 remain open |

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
