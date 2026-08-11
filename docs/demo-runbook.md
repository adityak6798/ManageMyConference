# Competition demo runbook

Status: canonical | Owner: quality | Governing IDs: `PRD-005`, `PLAN-002`, `ACC-DEMO-SMOKE` | Last verified: 2026-08-10

## Start from a clean checkout

Use Node from `.nvmrc`, npm 11.12.1, and a local Python supported by `uv`.

```bash
npm ci
uv sync --locked
npm run setup:local
npm run reset
npm run dev
```

Open `http://127.0.0.1:5173`. The reset is deterministic and safe to repeat. It restores the same event, CFP, proposals, review assignments, speakers, CRM records, agenda, delivery history, and published projection. Local delivery and uploads use deterministic adapters and require no live credentials.

## Evaluator path

1. Continue as **organizer**. Use the single event workspace to show CFP configuration, abstract triage, accepted sessions and speakers, agenda publication, CRM, and delivery history.
2. Switch to **reviewer** and complete the seeded assignment. Role-limited navigation and forbidden organizer data demonstrate event-scoped authorization.
3. Switch to **speaker** and show profile, tasks, private assets, calendar download, and assigned sessions.
4. Switch to **public** to submit through the live CFP without gaining private workspace access.
5. Open `/events/greenroom-demo-summit` and follow schedule, session, speaker, and CFP links. Open `/embed/events/greenroom-demo-summit/schedule` to show the same immutable public projection.
6. Return as **organizer**, inspect communications history, and show queued, retrying, succeeded, and terminal delivery states plus the explicit retry control.

The role switcher establishes signed development-only sessions and does not bypass application authorization. The API refuses demo mode outside the exact development environment.

## Reproduce the evidence

```bash
npm run check
npm run reset
npm run test:e2e
npm run test:quality
```

`test:e2e` runs the current domain `ACC-*` browser scenarios serially against one clean D1 reset. Those scenarios use deterministic domain fixtures; they do not yet prove that one newly submitted proposal crosses every domain through publication. That chained acceptance remains tracked by issue #10. `test:quality` is the fast evaluator gate: it checks role-aware journey discovery, public semantics and labels, heading structure, responsive public behavior inherited from `ACC-PUBLIC`, and conservative loading/resource smoke budgets. CI separately runs unit/API tests, the complete D1 migration suite, builds, OpenAPI drift checks, security checks, and this browser evidence.

If a step fails, preserve the displayed correlation reference and Playwright artifacts. Reset before retrying; never repair demo state with manual database edits.
