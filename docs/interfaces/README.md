# Interface catalog

Status: canonical | Owner: architecture | Last verified: 2026-08-09

Shared Zod schemas own every current request and response shape: event mutations/lists, demo session, health, and the standard error envelope. They generate [`packages/contracts/openapi.json`](../../packages/contracts/openapi.json), and CI rejects drift. The OpenAPI document covers health, the internal demo-cookie route, event routes, cookie security, and implemented success/error statuses. Domain types own business semantics. Drizzle declares the event storage schema, while an immutable SQL migration owns deployed history and the D1 adapter owns persistence behavior. Explicit tested mappers connect transport, domain, and storage models.

## Route groups

- `API-AUTH-*`: session, seeded demo identity switch, current capabilities.
- `API-ORG-*`, `API-EVENT-*`: organization/event commands and queries.
- `API-CFP-*`, `API-REVIEW-*`: forms, submissions, assignments, evaluations.
- `API-CONTENT-*`, `API-CRM-*`: speakers, sessions, tasks/assets, prospects/activity/conversion.
- `API-AGENDA-*`: rooms, tracks, placements, conflicts.
- `API-COMMS-*`, `API-INTEGRATION-*`: templates, outbox, attempts, projection state.
- `API-PUBLIC-*`: published hub, schedule, sessions, speakers, and CFP/embed reads.

The event reference routes use expiring signed HttpOnly demo-session cookies and enforce actor capability in the application service, returning distinct 401 and 403 envelopes. `/api/demo-session` is an internal harness route: it is available only with `DEMO_MODE=true` and `ENVIRONMENT=development`, returns 404 when demo mode is disabled, and fails closed for missing, misspelled, or non-development environments. Event scope/tenancy expands when organizations and multiple events are implemented. Idempotency for repeatable mutations and stable cursor pagination/filtering remain interface requirements for relevant future routes. Errors follow [`ARC-ERR-001`](../architecture/error-observability.md).

## Domain events

- `EVT-SUBMISSION-RECEIVED`
- `EVT-REVIEW-COMPLETED`
- `EVT-CONTENT-ACCEPTED`
- `EVT-SPEAKER-CONVERTED`
- `EVT-SCHEDULE-PUBLISHED`
- `EVT-PROJECTION-REQUESTED`

Events are versioned facts with organization/event scope, event ID, occurrence time, correlation ID, and causation ID. Consumers are idempotent. They coordinate domains; they are not an untyped dumping ground.

Provider ports and semantics are defined in [integrations](../architecture/integrations.md). Generated OpenAPI is linked above and checked for drift in CI.
