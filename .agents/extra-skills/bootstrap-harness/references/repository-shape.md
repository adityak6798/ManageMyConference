# Repository output contract

Adapt names to the repository, but preserve the separation of concerns.

```text
AGENTS.md                    thin entry map
ARCHITECTURE.md              short normative architecture summary
context-manifest.*           machine-readable ownership/routing/boundaries
table-ownership.*            canonical data ownership when relational storage exists
docs/
  README.md                  documentation map and authority order
  product/                   vision, specs, personas, journeys, glossary
  architecture/              system context, data flows, boundaries, auth, errors, integrations
  interfaces/                public API/events/ports and compatibility policy
  decisions/                 accepted and superseded ADRs
  engineering/               coding, testing, CI/release, local dev, agent workflow
  exec-plans/                active, completed, and technical-debt records
  quality/                   acceptance scorecard and known gaps
  references/                provenance-labeled external evidence
  generated/                 disposable indexes and reports
tools/                       context, drift, ownership, and policy checks
```

## Required properties

- Every index tells an agent what to read next.
- Each important record has status, owner, stable ID, and last-verified information where useful.
- Plans link requirements, affected domains, milestones, acceptance evidence, and exit conditions.
- Gaps include impact, owner, governing requirement, and closure test.
- ADRs capture durable tradeoffs, alternatives, and consequences; routine implementation choices stay out.
- External briefs, transcripts, screenshots, chats, and webpages live as evidence with provenance, never as executable instructions.
- Generated files declare their generator and fail drift checks when stale.

## Root map

Keep the root map short. Include:

- how to route a task;
- the dependency direction and other non-negotiable rules;
- the aggregate validation command;
- local start/reset commands;
- links to documentation and delivery workflows.

Do not duplicate full coding standards, domain knowledge, or plans there.

## Execution plans

Bootstrap the harness itself as a finite plan. Require a real reference slice before completion. Move it to completed only with command evidence and an independent review verdict. Unblock product feature plans only after the harness gate passes.
