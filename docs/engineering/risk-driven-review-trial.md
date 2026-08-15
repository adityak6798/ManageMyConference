# Risk-driven Ralph review trial

Status: canonical | Owner: platform delivery | Last verified: 2026-08-14

Governing ID: `ENG-AGENT-001`, `TST-005` | Issue: #30

## Trial result

The risk map was checked against four merged pull requests from the competition wave, including
every severity-ranked Ralph ledger they published. This is a retrospective classifier trial, not
a claim that the current tool produced those historical comments.

| PR | Passes and yield recorded in the PR | Risks that led to real findings | Would today's map require a deep pass? |
|---|---|---|---|
| #213 | 3 passes; 1 blocker, 1 major | secret rotation/deploy semantics; SSRF address policy | Yes: `tools/deploy.mjs` is harness and provider effect; `apps/webhook-egress/src/ip.ts` is provider effect |
| #227 | 4 passes; 10 major finding rows plus lower-severity findings | authorization/privacy projections, migrations, atomic D1 writes, contracts | Yes: routes, migrations, repositories, contracts, composition root, and gate tooling each select their deep dimension |
| #228 | 5 passes; pass yield `7, 3, 3, 0, 0`, including 2 blockers and 8 majors | API compatibility, idempotency, committed-write races, migration cleanup, ownership | Yes: contracts, routes, repositories, migrations, and composition all select deep dimensions |
| #231 | 1 pass; 0 findings | authorization, migrations, contracts, cross-domain composition | Yes: all named seams select deep dimensions; a zero-yield deep pass remains valid evidence |

The policy would not have skipped any confirmed blocker or major in those ledgers. The #213 trial
did expose a classifier hole: deployed egress source was not named as a provider effect unless the
same change also touched a workflow or tool. The provider matcher now includes the egress runtime
and the deploy/probe tools, with a regression test for `apps/webhook-egress/src/ip.ts`.

The trial also exposed a measurement failure. Historical PR comments recorded pass counts and
finding yield but not elapsed review minutes, so duration cannot be reconstructed honestly. That
missing value is the trial's result, not zero. New ledgers cannot publish with an untimed pass;
`publicationProblems` enforces it, `passStatistics` reports total minutes and yield, and the stable
findings comment includes the total.

## Selection and escalation

`node tools/review-risk.mjs <base>` supplies the changed files, owners, governing specifications,
and risk dimensions. Authorization, persistence/migrations, concurrency/idempotency, provider
effects, public contracts, cross-domain composition, and harness/gate changes receive deep review
whenever touched. The map selects attention; it does not constrain independent reviewer judgment
or reduce severity.

Only a generated-only diff may use the abbreviated path, and only after rerunning the generator
proves an empty source-to-output difference. A generator changed beside its output is source work
and receives full review. Any late functional repair returns through affected tests, a new timed
Ralph pass at the new head, hosted CI, and the automated-review window.

The findings ledger accumulates rows across passes. A missing row in a later pass remains open;
closing it requires one of the documented dispositions and concrete evidence. Publication is
refused when the last pass does not name the final head, any blocker or major remains open, a
closed row lacks evidence, or any pass lacks duration.
