<!-- GENERATED: do not edit; run `npm run context -- generate`. -->
# Generated context index

| Domain | Specs | Journeys | Acceptance | Plans | Index |
|---|---|---|---|---|---|
| platform | `ARC-001`, `ARC-DOM-001`, `ENG-CI-001` | — | `ACC-HARNESS`, `ACC-DEMO-SMOKE` | `PLAN-001`, `PLAN-002` | [docs/architecture/README.md](../architecture/README.md) |
| identity-access | `PRD-IAM-001`, `PRD-IAM-002` | — | — | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| events | `PRD-EVT-001` | — | `ACC-IDENTITY-EVENTS` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| cfp | `PRD-CFP-001`, `PRD-CFP-002`, `PRD-ABS-001` | `JNY-001`, `JNY-002` | `ACC-CFP` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| review | `PRD-REV-001` | `JNY-003` | `ACC-REVIEW` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| content | `PRD-SPK-001`, `PRD-SPK-002`, `PRD-CNT-001` | `JNY-004`, `JNY-005` | `ACC-SPEAKER` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| crm | `PRD-CRM-001` | `JNY-008` | `ACC-CRM` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| agenda | `PRD-AGD-001` | `JNY-006` | `ACC-AGENDA` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| communications-integrations | `PRD-COM-001`, `PRD-INT-001` | `JNY-009` | `ACC-INTEGRATION` | `PLAN-002` | [docs/product/specifications.md](../product/specifications.md) |
| publishing | `PRD-PUB-001` | `JNY-007` | `ACC-PUBLIC` | `PLAN-002`, `PLAN-003` | [docs/product/specifications.md](../product/specifications.md) |

## Identifier backlinks

### `ACC-AGENDA`
- `test` / `repository-fact`: [apps/api/test/agenda-service.test.ts](../../apps/api/test/agenda-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-agenda-repository.integration.test.ts](../../apps/api/test/d1-agenda-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/agenda.spec.ts](../../apps/web/e2e/agenda.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/event-scoped-loading.spec.ts](../../apps/web/e2e/event-scoped-loading.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle.spec.ts](../../apps/web/e2e/lifecycle.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/reference-slice.spec.ts](../../apps/web/e2e/reference-slice.spec.ts)
- `test` / `repository-fact`: [apps/web/test/agenda-failure-feedback.test.tsx](../../apps/web/test/agenda-failure-feedback.test.tsx)
- `test` / `repository-fact`: [apps/web/test/agenda-timeslots.test.tsx](../../apps/web/test/agenda-timeslots.test.tsx)
- `test` / `repository-fact`: [apps/web/test/agenda-timezone.test.tsx](../../apps/web/test/agenda-timezone.test.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-CFP`
- `test` / `repository-fact`: [apps/api/test/cfp-http.test.ts](../../apps/api/test/cfp-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/cfp-service.test.ts](../../apps/api/test/cfp-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-cfp-repository.integration.test.ts](../../apps/api/test/d1-cfp-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/seed-state.integration.test.ts](../../apps/api/test/seed-state.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/00-seed-state.spec.ts](../../apps/web/e2e/00-seed-state.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/cfp.spec.ts](../../apps/web/e2e/cfp.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle.spec.ts](../../apps/web/e2e/lifecycle.spec.ts)
- `test` / `repository-fact`: [apps/web/test/cfp-composer.test.tsx](../../apps/web/test/cfp-composer.test.tsx)
- `test` / `repository-fact`: [apps/web/test/cfp-republish-closed.test.tsx](../../apps/web/test/cfp-republish-closed.test.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-CRM`
- `test` / `repository-fact`: [apps/api/test/crm-http.test.ts](../../apps/api/test/crm-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/crm-service.test.ts](../../apps/api/test/crm-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-crm-repository.integration.test.ts](../../apps/api/test/d1-crm-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-speaker-conversion.integration.test.ts](../../apps/api/test/d1-speaker-conversion.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/crm.spec.ts](../../apps/web/e2e/crm.spec.ts)
- `test` / `repository-fact`: [apps/web/test/crm-owner-assignment.test.tsx](../../apps/web/test/crm-owner-assignment.test.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-DEMO-SMOKE`
- `test` / `repository-fact`: [apps/web/e2e/00-seed-state.spec.ts](../../apps/web/e2e/00-seed-state.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle-demo.spec.ts](../../apps/web/e2e/lifecycle-demo.spec.ts)
- `specification` / `normative`: [docs/demo-runbook.md](../../docs/demo-runbook.md)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)
- `specification` / `normative`: [docs/exec-plans/tech-debt.md](../../docs/exec-plans/tech-debt.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-HARNESS`
- `test` / `repository-fact`: [apps/api/test/api-docs.test.ts](../../apps/api/test/api-docs.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-event-repository.integration.test.ts](../../apps/api/test/d1-event-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-harness.integration.test.ts](../../apps/api/test/d1-harness.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/demo-session.test.ts](../../apps/api/test/demo-session.test.ts)
- `test` / `repository-fact`: [apps/api/test/event-mappers.test.ts](../../apps/api/test/event-mappers.test.ts)
- `test` / `repository-fact`: [apps/api/test/event-service.test.ts](../../apps/api/test/event-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/http.test.ts](../../apps/api/test/http.test.ts)
- `test` / `repository-fact`: [apps/api/test/runtime-auth.test.ts](../../apps/api/test/runtime-auth.test.ts)
- `test` / `repository-fact`: [apps/web/test/api-config.test.ts](../../apps/web/test/api-config.test.ts)
- `test` / `repository-fact`: [apps/web/test/error-fallback.test.tsx](../../apps/web/test/error-fallback.test.tsx)
- `test` / `repository-fact`: [apps/web/test/overview-dashboard.test.tsx](../../apps/web/test/overview-dashboard.test.tsx)
- `test` / `repository-fact`: [apps/web/test/router.test.tsx](../../apps/web/test/router.test.tsx)
- `test` / `repository-fact`: [apps/web/test/shell-error-surface.test.tsx](../../apps/web/test/shell-error-surface.test.tsx)
- `specification` / `normative`: [docs/exec-plans/completed.md](../../docs/exec-plans/completed.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)
- `test` / `repository-fact`: [tools/tests/check-errors.test.mjs](../../tools/tests/check-errors.test.mjs)
- `test` / `repository-fact`: [tools/tests/check-evidence.test.mjs](../../tools/tests/check-evidence.test.mjs)
- `test` / `repository-fact`: [tools/tests/check-gate-drift.test.mjs](../../tools/tests/check-gate-drift.test.mjs)
- `test` / `repository-fact`: [tools/tests/check-schema-drift.test.mjs](../../tools/tests/check-schema-drift.test.mjs)
- `test` / `repository-fact`: [tools/tests/compose-seed.test.mjs](../../tools/tests/compose-seed.test.mjs)
- `test` / `repository-fact`: [tools/tests/review-loop.test.mjs](../../tools/tests/review-loop.test.mjs)
- `test` / `repository-fact`: [tools/tests/test_context.py](../../tools/tests/test_context.py)
- `test` / `repository-fact`: [tools/tests/worktree-env.test.mjs](../../tools/tests/worktree-env.test.mjs)

### `ACC-IDENTITY-EVENTS`
- `test` / `repository-fact`: [apps/api/test/actor.test.ts](../../apps/api/test/actor.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-identity-directory.integration.test.ts](../../apps/api/test/d1-identity-directory.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/real-auth.test.ts](../../apps/api/test/real-auth.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/reference-slice.spec.ts](../../apps/web/e2e/reference-slice.spec.ts)
- `test` / `repository-fact`: [apps/web/test/App.test.tsx](../../apps/web/test/App.test.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-INTEGRATION`
- `test` / `repository-fact`: [apps/api/test/communications-http.test.ts](../../apps/api/test/communications-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/communications-service.test.ts](../../apps/api/test/communications-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-communications-repository.integration.test.ts](../../apps/api/test/d1-communications-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/communications.spec.ts](../../apps/web/e2e/communications.spec.ts)
- `test` / `repository-fact`: [apps/web/test/communications.test.tsx](../../apps/web/test/communications.test.tsx)
- `specification` / `normative`: [docs/README.md](../../docs/README.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-PUBLIC`
- `test` / `repository-fact`: [apps/api/test/d1-publication-repository.integration.test.ts](../../apps/api/test/d1-publication-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/publication.test.ts](../../apps/api/test/publication.test.ts)
- `test` / `repository-fact`: [apps/api/test/seed-state.integration.test.ts](../../apps/api/test/seed-state.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/00-seed-state.spec.ts](../../apps/web/e2e/00-seed-state.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/event-scoped-loading.spec.ts](../../apps/web/e2e/event-scoped-loading.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle.spec.ts](../../apps/web/e2e/lifecycle.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/public-event.spec.ts](../../apps/web/e2e/public-event.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/publishing.spec.ts](../../apps/web/e2e/publishing.spec.ts)
- `test` / `repository-fact`: [apps/web/test/public-event-pages.test.tsx](../../apps/web/test/public-event-pages.test.tsx)
- `test` / `repository-fact`: [apps/web/test/publishing.test.tsx](../../apps/web/test/publishing.test.tsx)
- `specification` / `normative`: [docs/architecture/authorization.md](../../docs/architecture/authorization.md)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-REVIEW`
- `test` / `repository-fact`: [apps/api/test/content-http.test.ts](../../apps/api/test/content-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-review-repository.integration.test.ts](../../apps/api/test/d1-review-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/review-http.test.ts](../../apps/api/test/review-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/review-service.test.ts](../../apps/api/test/review-service.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/event-scoped-loading.spec.ts](../../apps/web/e2e/event-scoped-loading.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle.spec.ts](../../apps/web/e2e/lifecycle.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/review-workflow.spec.ts](../../apps/web/e2e/review-workflow.spec.ts)
- `test` / `repository-fact`: [apps/web/test/proposal-acceptance.test.tsx](../../apps/web/test/proposal-acceptance.test.tsx)
- `test` / `repository-fact`: [apps/web/test/review-decisions.test.tsx](../../apps/web/test/review-decisions.test.tsx)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-SPEAKER`
- `test` / `repository-fact`: [apps/api/test/content-calendar-publication.test.ts](../../apps/api/test/content-calendar-publication.test.ts)
- `test` / `repository-fact`: [apps/api/test/content-http.test.ts](../../apps/api/test/content-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/content-service.test.ts](../../apps/api/test/content-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-content-repository.integration.test.ts](../../apps/api/test/d1-content-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/event-scoped-loading.spec.ts](../../apps/web/e2e/event-scoped-loading.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/lifecycle.spec.ts](../../apps/web/e2e/lifecycle.spec.ts)
- `test` / `repository-fact`: [apps/web/e2e/speaker-portal.spec.ts](../../apps/web/e2e/speaker-portal.spec.ts)
- `test` / `repository-fact`: [apps/web/test/proposal-acceptance.test.tsx](../../apps/web/test/proposal-acceptance.test.tsx)
- `test` / `repository-fact`: [apps/web/test/session-withdrawal.test.tsx](../../apps/web/test/session-withdrawal.test.tsx)
- `test` / `repository-fact`: [apps/web/test/speaker-photo.test.tsx](../../apps/web/test/speaker-photo.test.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ARC-001`
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/contract.ts](../../apps/api/src/transport/http/routes/contract.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/platform.ts](../../apps/api/src/transport/http/routes/platform.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/registry.ts](../../apps/api/src/transport/http/routes/registry.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/runtime.ts](../../apps/api/src/transport/http/runtime.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/contract.ts](../../apps/web/src/workspaces/contract.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/registry.tsx](../../apps/web/src/workspaces/registry.tsx)
- `specification` / `normative`: [docs/architecture/system-context.md](../../docs/architecture/system-context.md)
- `code` / `repository-fact`: [packages/contracts/openapi/contract.ts](../../packages/contracts/openapi/contract.ts)
- `code` / `repository-fact`: [packages/contracts/openapi/registry.ts](../../packages/contracts/openapi/registry.ts)
- `code` / `repository-fact`: [packages/contracts/scripts/generate-openapi.ts](../../packages/contracts/scripts/generate-openapi.ts)

### `ARC-DOM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/registry.ts](../../apps/api/src/adapters/persistence/schema/registry.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/contract.ts](../../apps/api/src/transport/http/routes/contract.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/registry.ts](../../apps/api/src/transport/http/routes/registry.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/contract.ts](../../apps/web/src/workspaces/contract.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/registry.tsx](../../apps/web/src/workspaces/registry.tsx)
- `specification` / `normative`: [docs/architecture/domain-boundaries.md](../../docs/architecture/domain-boundaries.md)
- `specification` / `normative`: [docs/engineering/registering-a-domain.md](../../docs/engineering/registering-a-domain.md)
- `code` / `repository-fact`: [tools/compose-seed.mjs](../../tools/compose-seed.mjs)
- `test` / `repository-fact`: [tools/tests/compose-seed.test.mjs](../../tools/tests/compose-seed.test.mjs)

### `ENG-CI-001`
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/platform.ts](../../apps/api/src/transport/http/routes/platform.ts)
- `specification` / `normative`: [docs/engineering/ci-and-release.md](../../docs/engineering/ci-and-release.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/openapi/contract.ts](../../packages/contracts/openapi/contract.ts)
- `code` / `repository-fact`: [packages/contracts/openapi/registry.ts](../../packages/contracts/openapi/registry.ts)
- `code` / `repository-fact`: [packages/contracts/scripts/generate-openapi.ts](../../packages/contracts/scripts/generate-openapi.ts)
- `code` / `repository-fact`: [tools/check-evidence.mjs](../../tools/check-evidence.mjs)
- `code` / `repository-fact`: [tools/check-gate-drift.mjs](../../tools/check-gate-drift.mjs)
- `code` / `repository-fact`: [tools/compose-seed.mjs](../../tools/compose-seed.mjs)
- `code` / `repository-fact`: [tools/greenroom_tools/context.py](../../tools/greenroom_tools/context.py)
- `code` / `repository-fact`: [tools/record-run.mjs](../../tools/record-run.mjs)
- `test` / `repository-fact`: [tools/tests/check-evidence.test.mjs](../../tools/tests/check-evidence.test.mjs)
- `test` / `repository-fact`: [tools/tests/check-gate-drift.test.mjs](../../tools/tests/check-gate-drift.test.mjs)
- `test` / `repository-fact`: [tools/tests/compose-seed.test.mjs](../../tools/tests/compose-seed.test.mjs)
- `test` / `repository-fact`: [tools/tests/test_context.py](../../tools/tests/test_context.py)

### `JNY-001`
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-002`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-003`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-004`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-005`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-006`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-007`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-008`
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `JNY-009`
- `specification` / `normative`: [docs/README.md](../../docs/README.md)
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `PLAN-001`
- `specification` / `normative`: [docs/exec-plans/completed.md](../../docs/exec-plans/completed.md)

### `PLAN-002`
- `specification` / `normative`: [docs/demo-runbook.md](../../docs/demo-runbook.md)
- `specification` / `normative`: [docs/engineering/registering-a-domain.md](../../docs/engineering/registering-a-domain.md)
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)

### `PLAN-003`
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)

### `PRD-ABS-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-submitted-proposal-adapter.ts](../../apps/api/src/adapters/persistence/d1-submitted-proposal-adapter.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/review.ts](../../apps/api/src/adapters/persistence/schema/review.ts)
- `code` / `repository-fact`: [apps/api/src/application/review/review-service.ts](../../apps/api/src/application/review/review-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/cfp.ts](../../apps/api/src/transport/http/routes/cfp.ts)
- `code` / `repository-fact`: [apps/web/src/review/OrganizerReviewWorkspace.tsx](../../apps/web/src/review/OrganizerReviewWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/review.ts](../../packages/contracts/src/domains/review.ts)

### `PRD-AGD-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/agenda.ts](../../apps/api/src/adapters/persistence/schema/agenda.ts)
- `code` / `repository-fact`: [apps/api/src/application/agenda/agenda-service.ts](../../apps/api/src/application/agenda/agenda-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/agenda/agenda.ts](../../apps/api/src/domain/agenda/agenda.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/agenda.ts](../../apps/api/src/transport/http/routes/agenda.ts)
- `code` / `repository-fact`: [apps/web/src/agenda/AgendaWorkspace.tsx](../../apps/web/src/agenda/AgendaWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/agenda/model.ts](../../apps/web/src/agenda/model.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/agenda.tsx](../../apps/web/src/workspaces/agenda.tsx)
- `specification` / `normative`: [docs/exec-plans/tech-debt.md](../../docs/exec-plans/tech-debt.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/agenda.ts](../../packages/contracts/src/domains/agenda.ts)
- `code` / `repository-fact`: [packages/contracts/src/domains/publishing.ts](../../packages/contracts/src/domains/publishing.ts)

### `PRD-CFP-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/cfp.ts](../../apps/api/src/adapters/persistence/schema/cfp.ts)
- `code` / `repository-fact`: [apps/api/src/application/cfp/cfp-service.ts](../../apps/api/src/application/cfp/cfp-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/cfp.ts](../../apps/api/src/transport/http/routes/cfp.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/cfp.tsx](../../apps/web/src/workspaces/cfp.tsx)
- `specification` / `normative`: [docs/exec-plans/tech-debt.md](../../docs/exec-plans/tech-debt.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/cfp.ts](../../packages/contracts/src/domains/cfp.ts)

### `PRD-CFP-002`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/cfp.ts](../../apps/api/src/adapters/persistence/schema/cfp.ts)
- `code` / `repository-fact`: [apps/api/src/application/cfp/cfp-service.ts](../../apps/api/src/application/cfp/cfp-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/cfp.ts](../../apps/api/src/transport/http/routes/cfp.ts)
- `code` / `repository-fact`: [apps/web/src/workspaces/cfp.tsx](../../apps/web/src/workspaces/cfp.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/cfp.ts](../../packages/contracts/src/domains/cfp.ts)

### `PRD-CNT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/content.ts](../../apps/api/src/adapters/persistence/schema/content.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/content.ts](../../apps/api/src/transport/http/routes/content.ts)
- `code` / `repository-fact`: [apps/web/src/content/ContentWorkspace.tsx](../../apps/web/src/content/ContentWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/content.tsx](../../apps/web/src/workspaces/content.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/content.ts](../../packages/contracts/src/domains/content.ts)
- `code` / `repository-fact`: [packages/contracts/src/domains/review.ts](../../packages/contracts/src/domains/review.ts)

### `PRD-COM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/communications-integrations.ts](../../apps/api/src/adapters/persistence/schema/communications-integrations.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/communications-service.ts](../../apps/api/src/application/communications/communications-service.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/outbox-worker.ts](../../apps/api/src/application/communications/outbox-worker.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/ports.ts](../../apps/api/src/application/communications/ports.ts)
- `code` / `repository-fact`: [apps/api/src/domain/communications/delivery.ts](../../apps/api/src/domain/communications/delivery.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/communications.ts](../../apps/api/src/transport/http/routes/communications.ts)
- `code` / `repository-fact`: [apps/web/src/CommunicationsWorkspace.tsx](../../apps/web/src/CommunicationsWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/communications.tsx](../../apps/web/src/workspaces/communications.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/communications-integrations.ts](../../packages/contracts/src/domains/communications-integrations.ts)

### `PRD-CRM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-crm-repository.ts](../../apps/api/src/adapters/persistence/d1-crm-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/crm.ts](../../apps/api/src/adapters/persistence/schema/crm.ts)
- `code` / `repository-fact`: [apps/api/src/application/crm/crm-service.ts](../../apps/api/src/application/crm/crm-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/crm/prospect.ts](../../apps/api/src/domain/crm/prospect.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/crm.ts](../../apps/api/src/transport/http/routes/crm.ts)
- `code` / `repository-fact`: [apps/web/src/CrmWorkspace.tsx](../../apps/web/src/CrmWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/crm.tsx](../../apps/web/src/workspaces/crm.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/crm.ts](../../packages/contracts/src/domains/crm.ts)

### `PRD-EVT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-identity-directory.ts](../../apps/api/src/adapters/persistence/d1-identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/events.ts](../../apps/api/src/adapters/persistence/schema/events.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/event-repository.ts](../../apps/api/src/application/events/event-repository.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/event-service.ts](../../apps/api/src/application/events/event-service.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/public.ts](../../apps/api/src/application/events/public.ts)
- `code` / `repository-fact`: [apps/api/src/index.ts](../../apps/api/src/index.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/events.ts](../../apps/api/src/transport/http/routes/events.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/events.ts](../../packages/contracts/src/domains/events.ts)

### `PRD-IAM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-identity-directory.ts](../../apps/api/src/adapters/persistence/d1-identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/identity-access.ts](../../apps/api/src/adapters/persistence/schema/identity-access.ts)
- `code` / `repository-fact`: [apps/api/src/application/identity/identity-directory.ts](../../apps/api/src/application/identity/identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/identity.ts](../../apps/api/src/transport/http/routes/identity.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [tools/setup-local.mjs](../../tools/setup-local.mjs)

### `PRD-IAM-002`
- `code` / `repository-fact`: [apps/api/src/application/crm/crm-service.ts](../../apps/api/src/application/crm/crm-service.ts)
- `code` / `repository-fact`: [apps/api/src/application/identity/identity-directory.ts](../../apps/api/src/application/identity/identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/identity.ts](../../apps/api/src/transport/http/routes/identity.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/contract.ts](../../apps/web/src/workspaces/contract.ts)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)

### `PRD-INT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/communications-integrations.ts](../../apps/api/src/adapters/persistence/schema/communications-integrations.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/outbox-worker.ts](../../apps/api/src/application/communications/outbox-worker.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/ports.ts](../../apps/api/src/application/communications/ports.ts)
- `code` / `repository-fact`: [apps/api/src/domain/communications/delivery.ts](../../apps/api/src/domain/communications/delivery.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/communications.ts](../../apps/api/src/transport/http/routes/communications.ts)
- `code` / `repository-fact`: [apps/web/src/CommunicationsWorkspace.tsx](../../apps/web/src/CommunicationsWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/communications.tsx](../../apps/web/src/workspaces/communications.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/communications-integrations.ts](../../packages/contracts/src/domains/communications-integrations.ts)

### `PRD-PUB-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-publication-repository.ts](../../apps/api/src/adapters/persistence/d1-publication-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/publishing.ts](../../apps/api/src/adapters/persistence/schema/publishing.ts)
- `code` / `repository-fact`: [apps/api/src/application/publishing/publication-repository.ts](../../apps/api/src/application/publishing/publication-repository.ts)
- `code` / `repository-fact`: [apps/api/src/application/publishing/publication-service.ts](../../apps/api/src/application/publishing/publication-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/publishing/publication.ts](../../apps/api/src/domain/publishing/publication.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/publishing.ts](../../apps/api/src/transport/http/routes/publishing.ts)
- `code` / `repository-fact`: [apps/web/src/PublishingWorkspace.tsx](../../apps/web/src/PublishingWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/api/publication.ts](../../apps/web/src/api/publication.ts)
- `code` / `repository-fact`: [apps/web/src/public-event/PublicEventApp.tsx](../../apps/web/src/public-event/PublicEventApp.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/publishing.tsx](../../apps/web/src/workspaces/publishing.tsx)
- `specification` / `normative`: [docs/interfaces/README.md](../../docs/interfaces/README.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/publishing.ts](../../packages/contracts/src/domains/publishing.ts)

### `PRD-REV-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-review-repository.ts](../../apps/api/src/adapters/persistence/d1-review-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/review.ts](../../apps/api/src/adapters/persistence/schema/review.ts)
- `code` / `repository-fact`: [apps/api/src/application/review/review-service.ts](../../apps/api/src/application/review/review-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/review.ts](../../apps/api/src/transport/http/routes/review.ts)
- `code` / `repository-fact`: [apps/web/src/review/OrganizerReviewWorkspace.tsx](../../apps/web/src/review/OrganizerReviewWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/review.tsx](../../apps/web/src/workspaces/review.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/review.ts](../../packages/contracts/src/domains/review.ts)

### `PRD-SPK-001`
- `code` / `repository-fact`: [apps/api/src/adapters/content/d1-speaker-conversion.ts](../../apps/api/src/adapters/content/d1-speaker-conversion.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/content.ts](../../apps/api/src/adapters/persistence/schema/content.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/content.ts](../../apps/api/src/transport/http/routes/content.ts)
- `code` / `repository-fact`: [apps/web/src/content/ContentWorkspace.tsx](../../apps/web/src/content/ContentWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/content.tsx](../../apps/web/src/workspaces/content.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/content.ts](../../packages/contracts/src/domains/content.ts)

### `PRD-SPK-002`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema/content.ts](../../apps/api/src/adapters/persistence/schema/content.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/storage/r2-asset-storage.ts](../../apps/api/src/adapters/storage/r2-asset-storage.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/routes/content.ts](../../apps/api/src/transport/http/routes/content.ts)
- `code` / `repository-fact`: [apps/web/src/content/ContentWorkspace.tsx](../../apps/web/src/content/ContentWorkspace.tsx)
- `code` / `repository-fact`: [apps/web/src/workspaces/content.tsx](../../apps/web/src/workspaces/content.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [packages/contracts/src/domains/content.ts](../../packages/contracts/src/domains/content.ts)

Trust: normative metadata plus declared repository facts.
