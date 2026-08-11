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
- `test` / `repository-fact`: [apps/web/e2e/reference-slice.spec.ts](../../apps/web/e2e/reference-slice.spec.ts)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-CFP`
- `test` / `repository-fact`: [apps/api/test/cfp-http.test.ts](../../apps/api/test/cfp-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/cfp-service.test.ts](../../apps/api/test/cfp-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-cfp-repository.integration.test.ts](../../apps/api/test/d1-cfp-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/seed-state.integration.test.ts](../../apps/api/test/seed-state.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/cfp.spec.ts](../../apps/web/e2e/cfp.spec.ts)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-CRM`
- `test` / `repository-fact`: [apps/api/test/crm-http.test.ts](../../apps/api/test/crm-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/crm-service.test.ts](../../apps/api/test/crm-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-crm-repository.integration.test.ts](../../apps/api/test/d1-crm-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-speaker-conversion.integration.test.ts](../../apps/api/test/d1-speaker-conversion.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/crm.spec.ts](../../apps/web/e2e/crm.spec.ts)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-DEMO-SMOKE`
- `test` / `repository-fact`: [apps/web/e2e/lifecycle-demo.spec.ts](../../apps/web/e2e/lifecycle-demo.spec.ts)
- `specification` / `normative`: [docs/demo-runbook.md](../../docs/demo-runbook.md)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-HARNESS`
- `test` / `repository-fact`: [apps/api/test/d1-event-repository.integration.test.ts](../../apps/api/test/d1-event-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/demo-session.test.ts](../../apps/api/test/demo-session.test.ts)
- `test` / `repository-fact`: [apps/api/test/event-mappers.test.ts](../../apps/api/test/event-mappers.test.ts)
- `test` / `repository-fact`: [apps/api/test/event-service.test.ts](../../apps/api/test/event-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/http.test.ts](../../apps/api/test/http.test.ts)
- `test` / `repository-fact`: [apps/api/test/runtime-auth.test.ts](../../apps/api/test/runtime-auth.test.ts)
- `test` / `repository-fact`: [apps/web/test/error-fallback.test.tsx](../../apps/web/test/error-fallback.test.tsx)
- `specification` / `normative`: [docs/exec-plans/completed.md](../../docs/exec-plans/completed.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)
- `test` / `repository-fact`: [tools/tests/check-errors.test.mjs](../../tools/tests/check-errors.test.mjs)
- `test` / `repository-fact`: [tools/tests/test_context.py](../../tools/tests/test_context.py)

### `ACC-IDENTITY-EVENTS`
- `test` / `repository-fact`: [apps/api/test/d1-identity-directory.integration.test.ts](../../apps/api/test/d1-identity-directory.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/reference-slice.spec.ts](../../apps/web/e2e/reference-slice.spec.ts)
- `test` / `repository-fact`: [apps/web/test/App.test.tsx](../../apps/web/test/App.test.tsx)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-INTEGRATION`
- `test` / `repository-fact`: [apps/api/test/communications-http.test.ts](../../apps/api/test/communications-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/communications-service.test.ts](../../apps/api/test/communications-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-communications-repository.integration.test.ts](../../apps/api/test/d1-communications-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/communications.spec.ts](../../apps/web/e2e/communications.spec.ts)
- `test` / `repository-fact`: [apps/web/test/communications.test.tsx](../../apps/web/test/communications.test.tsx)
- `specification` / `normative`: [docs/README.md](../../docs/README.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-PUBLIC`
- `test` / `repository-fact`: [apps/api/test/d1-publication-repository.integration.test.ts](../../apps/api/test/d1-publication-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/publication.test.ts](../../apps/api/test/publication.test.ts)
- `test` / `repository-fact`: [apps/api/test/seed-state.integration.test.ts](../../apps/api/test/seed-state.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/public-event.spec.ts](../../apps/web/e2e/public-event.spec.ts)
- `specification` / `normative`: [docs/architecture/authorization.md](../../docs/architecture/authorization.md)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-REVIEW`
- `test` / `repository-fact`: [apps/api/test/d1-review-repository.integration.test.ts](../../apps/api/test/d1-review-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/api/test/review-http.test.ts](../../apps/api/test/review-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/review-service.test.ts](../../apps/api/test/review-service.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/review-workflow.spec.ts](../../apps/web/e2e/review-workflow.spec.ts)
- `specification` / `normative`: [docs/engineering/testing-strategy.md](../../docs/engineering/testing-strategy.md)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ACC-SPEAKER`
- `test` / `repository-fact`: [apps/api/test/content-http.test.ts](../../apps/api/test/content-http.test.ts)
- `test` / `repository-fact`: [apps/api/test/content-service.test.ts](../../apps/api/test/content-service.test.ts)
- `test` / `repository-fact`: [apps/api/test/d1-content-repository.integration.test.ts](../../apps/api/test/d1-content-repository.integration.test.ts)
- `test` / `repository-fact`: [apps/web/e2e/speaker-portal.spec.ts](../../apps/web/e2e/speaker-portal.spec.ts)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `ARC-001`
- `specification` / `normative`: [docs/architecture/system-context.md](../../docs/architecture/system-context.md)

### `ARC-DOM-001`
- `specification` / `normative`: [docs/architecture/domain-boundaries.md](../../docs/architecture/domain-boundaries.md)

### `ENG-CI-001`
- `specification` / `normative`: [docs/engineering/ci-and-release.md](../../docs/engineering/ci-and-release.md)
- `specification` / `normative`: [docs/quality/known-gaps.md](../../docs/quality/known-gaps.md)
- `code` / `repository-fact`: [tools/greenroom_tools/context.py](../../tools/greenroom_tools/context.py)
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
- `specification` / `normative`: [docs/product/personas-and-journeys.md](../../docs/product/personas-and-journeys.md)
- `specification` / `normative`: [docs/quality/scorecard.md](../../docs/quality/scorecard.md)

### `PLAN-001`
- `specification` / `normative`: [docs/exec-plans/completed.md](../../docs/exec-plans/completed.md)

### `PLAN-002`
- `specification` / `normative`: [docs/demo-runbook.md](../../docs/demo-runbook.md)
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)

### `PLAN-003`
- `specification` / `normative`: [docs/exec-plans/active.md](../../docs/exec-plans/active.md)

### `PRD-ABS-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-submitted-proposal-adapter.ts](../../apps/api/src/adapters/persistence/d1-submitted-proposal-adapter.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/review/review-service.ts](../../apps/api/src/application/review/review-service.ts)
- `code` / `repository-fact`: [apps/web/src/ReviewWorkspace.tsx](../../apps/web/src/ReviewWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-AGD-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/agenda/agenda-service.ts](../../apps/api/src/application/agenda/agenda-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/agenda/agenda.ts](../../apps/api/src/domain/agenda/agenda.ts)
- `code` / `repository-fact`: [apps/web/src/AgendaWorkspace.tsx](../../apps/web/src/AgendaWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-CFP-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/cfp/cfp-service.ts](../../apps/api/src/application/cfp/cfp-service.ts)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-CFP-002`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/cfp/cfp-service.ts](../../apps/api/src/application/cfp/cfp-service.ts)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-CNT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/web/src/ContentWorkspace.tsx](../../apps/web/src/ContentWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-COM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/communications-service.ts](../../apps/api/src/application/communications/communications-service.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/outbox-worker.ts](../../apps/api/src/application/communications/outbox-worker.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/ports.ts](../../apps/api/src/application/communications/ports.ts)
- `code` / `repository-fact`: [apps/api/src/domain/communications/delivery.ts](../../apps/api/src/domain/communications/delivery.ts)
- `code` / `repository-fact`: [apps/web/src/CommunicationsWorkspace.tsx](../../apps/web/src/CommunicationsWorkspace.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-CRM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-crm-repository.ts](../../apps/api/src/adapters/persistence/d1-crm-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/crm/crm-service.ts](../../apps/api/src/application/crm/crm-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/crm/prospect.ts](../../apps/api/src/domain/crm/prospect.ts)
- `code` / `repository-fact`: [apps/web/src/CrmWorkspace.tsx](../../apps/web/src/CrmWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-EVT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-identity-directory.ts](../../apps/api/src/adapters/persistence/d1-identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/event-repository.ts](../../apps/api/src/application/events/event-repository.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/event-service.ts](../../apps/api/src/application/events/event-service.ts)
- `code` / `repository-fact`: [apps/api/src/application/events/public.ts](../../apps/api/src/application/events/public.ts)
- `code` / `repository-fact`: [apps/api/src/index.ts](../../apps/api/src/index.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-IAM-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-identity-directory.ts](../../apps/api/src/adapters/persistence/d1-identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/identity/identity-directory.ts](../../apps/api/src/application/identity/identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [tools/setup-local.mjs](../../tools/setup-local.mjs)

### `PRD-IAM-002`
- `code` / `repository-fact`: [apps/api/src/application/identity/identity-directory.ts](../../apps/api/src/application/identity/identity-directory.ts)
- `code` / `repository-fact`: [apps/api/src/transport/http/app.ts](../../apps/api/src/transport/http/app.ts)
- `code` / `repository-fact`: [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)

### `PRD-INT-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/outbox-worker.ts](../../apps/api/src/application/communications/outbox-worker.ts)
- `code` / `repository-fact`: [apps/api/src/application/communications/ports.ts](../../apps/api/src/application/communications/ports.ts)
- `code` / `repository-fact`: [apps/api/src/domain/communications/delivery.ts](../../apps/api/src/domain/communications/delivery.ts)
- `code` / `repository-fact`: [apps/web/src/CommunicationsWorkspace.tsx](../../apps/web/src/CommunicationsWorkspace.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-PUB-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-publication-repository.ts](../../apps/api/src/adapters/persistence/d1-publication-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/publishing/publication-repository.ts](../../apps/api/src/application/publishing/publication-repository.ts)
- `code` / `repository-fact`: [apps/api/src/application/publishing/publication-service.ts](../../apps/api/src/application/publishing/publication-service.ts)
- `code` / `repository-fact`: [apps/api/src/domain/publishing/publication.ts](../../apps/api/src/domain/publishing/publication.ts)
- `code` / `repository-fact`: [apps/web/src/PublicEventApp.tsx](../../apps/web/src/PublicEventApp.tsx)
- `code` / `repository-fact`: [apps/web/src/api/publication.ts](../../apps/web/src/api/publication.ts)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-REV-001`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/d1-review-repository.ts](../../apps/api/src/adapters/persistence/d1-review-repository.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/review/review-service.ts](../../apps/api/src/application/review/review-service.ts)
- `code` / `repository-fact`: [apps/web/src/ReviewWorkspace.tsx](../../apps/web/src/ReviewWorkspace.tsx)
- `specification` / `normative`: [docs/product/competition-traceability.md](../../docs/product/competition-traceability.md)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-SPK-001`
- `code` / `repository-fact`: [apps/api/src/adapters/content/d1-speaker-conversion.ts](../../apps/api/src/adapters/content/d1-speaker-conversion.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/web/src/ContentWorkspace.tsx](../../apps/web/src/ContentWorkspace.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

### `PRD-SPK-002`
- `code` / `repository-fact`: [apps/api/src/adapters/persistence/schema.ts](../../apps/api/src/adapters/persistence/schema.ts)
- `code` / `repository-fact`: [apps/api/src/adapters/storage/r2-asset-storage.ts](../../apps/api/src/adapters/storage/r2-asset-storage.ts)
- `code` / `repository-fact`: [apps/api/src/application/content/content-service.ts](../../apps/api/src/application/content/content-service.ts)
- `code` / `repository-fact`: [apps/web/src/ContentWorkspace.tsx](../../apps/web/src/ContentWorkspace.tsx)
- `specification` / `normative`: [docs/product/specifications.md](../../docs/product/specifications.md)
- `code` / `repository-fact`: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

Trust: normative metadata plus declared repository facts.
