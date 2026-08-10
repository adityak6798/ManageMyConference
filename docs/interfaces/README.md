# Interface catalog

Status: canonical | Owner: architecture | Last verified: 2026-08-09

Shared Zod schemas own every current request and response shape: event mutations/lists/basic metadata, current session/capabilities, demo session, health, and the standard error envelope. They generate [`packages/contracts/openapi.json`](../../packages/contracts/openapi.json), and CI rejects drift. The OpenAPI document covers health, the internal demo-cookie route, session and event routes, cookie security, and implemented success/error statuses. Domain types own business semantics. Drizzle declares intended storage, immutable SQL migrations own deployed history, and the D1 adapter owns persistence behavior. Explicit tested mappers connect transport, domain, and storage models.

## Route groups

- `API-AUTH-*`: session, seeded demo identity switch, current capabilities.
- `API-ORG-*`, `API-EVENT-*`: organization/event commands and queries.
- `API-CFP-*`, `API-REVIEW-*`: forms, submissions, assignments, evaluations.
- `API-CONTENT-*`, `API-CRM-*`: speakers, sessions, tasks/assets, prospects/activity/conversion.
- `API-AGENDA-*`: rooms, tracks, placements, conflicts.
- `API-COMMS-*`, `API-INTEGRATION-*`: templates, outbox, attempts, projection state.
- `API-PUBLIC-*`: published hub, schedule, sessions, speakers, and CFP/embed reads.

`GET /api/session` returns the current actor, organization memberships, event roles, and capabilities. `GET /api/events` returns only events visible through those memberships or assignments; `POST /api/events` requires an explicit `organizationId`, and `GET /api/events/{eventId}` applies tenant scope and returns the same 404 for missing and inaccessible events. These routes use expiring signed HttpOnly demo-session cookies and application-layer capability enforcement. `/api/demo-session` is an internal harness route: it is available only with `DEMO_MODE=true` and `ENVIRONMENT=development`, returns 404 when demo mode is disabled, and fails closed for missing, misspelled, or non-development environments. Idempotency for repeatable mutations and stable cursor pagination/filtering remain interface requirements for relevant future routes. Errors follow [`ARC-ERR-001`](../architecture/error-observability.md).

Migration `0002_identity_event_foundation.sql` preserves pre-foundation events under a stable imported organization and assigns the seeded organizer membership/event roles before adding organization scope. Deterministic reset replaces that imported state with the role-complete local fixture.

## Domain events

- `EVT-SUBMISSION-RECEIVED`
- `EVT-REVIEW-COMPLETED`
- `EVT-CONTENT-ACCEPTED`
- `EVT-SPEAKER-CONVERTED`
- `EVT-SCHEDULE-PUBLISHED`
- `EVT-PROJECTION-REQUESTED`

Events are versioned facts with organization/event scope, event ID, occurrence time, correlation ID, and causation ID. Consumers are idempotent. They coordinate domains; they are not an untyped dumping ground.

Provider ports and semantics are defined in [integrations](../architecture/integrations.md). Generated OpenAPI is linked above and checked for drift in CI.

## Communications and integration routes

- `POST /api/communications/templates` creates an immutable, organization-scoped template version.
- `POST /api/communications/deliveries` accepts a typed trigger and stable idempotency key, returning the existing delivery for a duplicate key.
- `GET /api/communications/history?organizationId={organizationId}&eventId={eventId}` returns delivery state with ordered immutable attempts.
- `POST /api/communications/deliveries/{deliveryId}/retry` explicitly requeues a retrying or terminal delivery without removing history.

All four routes require `communications:manage` and enforce the owning organization. Email deliveries require a known template key/version. Airtable and Accelevents deliveries require a positive projection version and are outbound-only; SQL remains canonical. The runtime schemas in `@greenroom/contracts` own validation for these request shapes.
