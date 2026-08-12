# Technical debt register

Status: canonical | Owner: engineering | Last verified: 2026-08-11 (commit `3630977`)

Accepted debt **is** recorded. Every entry carries an ID, impact, owner, governing spec,
reproduction or evidence, intended resolution, and a review trigger. A TODO comment without a linked
debt or plan ID fails policy.

Debt here is work that was consciously deferred with a known cost. Absent product capability —
including missing brief features — belongs in [known gaps](../quality/known-gaps.md) instead.

## The five items deferred by issue #10

Issue #10's "Deferred follow-ups" section is the authority for these five. Three have since been
delivered; their rows stay so the register accounts for every one of them.

| ID | Debt | Owner | Status | Closure test |
|---|---|---|---|---|
| `DEBT-001` | Organizer task and message controls targeted the first speaker profile in the workspace payload rather than a chosen speaker (deferred from issue #5 / PR #19) | content | **closed 2026-08-11** (issue #53) | `apps/web/e2e/speaker-portal.spec.ts` selects "Sam Speaker — Greenroom Labs" in the Speaker follow-up region and asserts both the task request and the recorded message name that speaker |
| `DEBT-002` | CRM prospect owner was free text, so an unknown or foreign owner produced a 500 instead of a field error (deferred from issue #6 / PR #15) | identity-access, crm | **closed 2026-08-11** (issue #67) | `apps/web/e2e/crm.spec.ts` "an owner the event does not staff is refused as a named field, not a crash"; the owner control is now a select populated from the identity-access staffing query (`apps/web/src/CrmWorkspace.tsx`) |
| `DEBT-003` | A stage change did not append a `stage-change` timeline activity, especially when a note was saved in the same update (deferred from issue #6 / PR #15) | crm | **closed 2026-08-11** (issue #67) | `apps/api/test/crm-service.test.ts` "records exactly one stage-change per transition, in the same write as the note", plus D1 (`d1-crm-repository.integration.test.ts`) and UI (`apps/web/test/crm-owner-assignment.test.tsx`) coverage |
| `DEBT-004` | Durable speaker-conversion claim rows left incomplete by a permanently failed workflow have no reconciliation, detection, or observability (deferred from issue #6 / PR #15) | content, operations | **open** | A documented retry/reconciliation policy, stale-claim detection, and operational evidence that a stuck claim is surfaced rather than silently retained |
| `DEBT-005` | The broader public-experience verification gates deferred from issue #9 / PR #16: accessibility auditing beyond the current smoke, production smoke coverage, and evaluator suites | quality, platform | **open** — see `GAP-014` | The `TST-006` release and scheduled-build gates exist, run against the integrated lifecycle, and their evidence is recorded in the scorecard and runbook (issues #48, #84) |

## Other accepted debt

| ID | Debt and impact | Owner | Governing ID | Closure test | Tracker |
|---|---|---|---|---|---|
| `DEBT-006` | Agenda publication writes its immutable snapshot but emits no durable `EVT-SCHEDULE-PUBLISHED`, so publication and its event are not one transaction and no consumer can rely on it | agenda | `PRD-AGD-001`, `EVT-SCHEDULE-PUBLISHED` | A publication that fails after the snapshot leaves no event, and a delivered event is proven idempotent for consumers | #22 |
| `DEBT-007` | The browser suite is re-runnable but accumulating: `publishing.spec.ts` leaves the event it creates, `review-workflow.spec.ts` files new abstracts, and `crm.spec.ts` adds a prospect on each run. Impact: an evaluator who demos after several runs meets a cluttered event switcher and triage table | quality | `ACC-DEMO-SMOKE` | Each spec removes what it creates, or the suite tags its rows and sweeps them, so two consecutive runs leave identical row counts | #72 (follow-up) |
| `DEBT-008` | `apps/web/src/AgendaWorkspace.tsx:362` falls back to `new Date()` for the zone abbreviation when a draft has no slots, so an empty board can label the conference with today's DST state rather than the event's | agenda | `PRD-AGD-001` | An empty board with an event in the opposite DST half renders the event's abbreviation, asserted in `apps/web/test/agenda-timezone.test.tsx` | — |
| `DEBT-009` | `clock.dayKey` costs three `Intl.formatToParts` calls and is called inside the week board's nested filter (`AgendaWorkspace.tsx:931`), so cell lookup is quadratic in slots | agenda | `PRD-AGD-001` | Day keys are computed once per slot and indexed; the week board renders from that index | — |
| `DEBT-010` | **Closed 2026-08-11:** CFP draft saves compare the editor's expected version atomically, return a typed conflict for stale writes, preserve the winning draft, and offer an explicit reload path | cfp | `PRD-CFP-001` | `d1-cfp-repository.integration.test.ts` proves exactly one competing update wins; `cfp-http.test.ts`, `cfp-composer.test.tsx`, and `cfp.spec.ts` cover the conflict and recovery | #20 |
| `DEBT-011` | Cross-cutting engineering debt accepted while the product surfaces were built: duplicated domain registration in the composition root (#24), duplicated D1 integration-test setup (#25), per-domain re-implementation of event-scoped authorization (#27), duplicated CI bootstrap steps (#29), failures that are hard to diagnose because FK and decode errors are untyped (#68), agenda placement N+1 and the organizer first-paint waterfall (#69), event-scoped workspace loading that can render stale or out-of-order data (#70), and duplicated CSS with no-op polish defects (#77) | engineering | `ARC-*`, `ENG-*` | Each linked issue closes with its own regression test; this row closes when all eight do | #24, #25, #27, #29, #68, #69, #70, #77 |

## Review trigger

Re-review this register whenever an `ACC-*` row changes verdict in the
[quality scorecard](../quality/scorecard.md), and before any release claim. A closed row is kept for
one further review cycle so the deferral is auditable, then removed.
