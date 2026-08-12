# Authorization

Status: canonical | Owner: security | ID: `ARC-AUTH-001` | Last verified: 2026-08-09

Authentication establishes identity; application authorization establishes organization/event scope and capability. Route visibility is convenience, never enforcement.

- Organizer: administer assigned organization/events and private event data.
- Reviewer: read assigned submission context and write only their own evaluations.
- Speaker: read/update their own event-scoped profile, tasks, assets, and sessions permitted for collaboration.
- Public: read published projections only.

Every protected application entrypoint receives actor plus event scope and denies by default. Object lookups include tenant scope to prevent enumeration. Logs and errors do not reveal whether an inaccessible record exists.

Actor-wide capabilities are a navigation and organization-level convenience: they are the union
of grants an actor holds and may authorize operations that genuinely have no event, such as
creating an event in an organization. Event-owned reads and mutations use
`requireEventCapability`, which considers every role grant on the named event and requires the
capability on that exact grant. An actor-wide capability never substitutes for the event grant.

The seeded demo authentication is harness-only. Production users request an emailed six-digit code,
exchange it for an expiring signed HttpOnly/SameSite cookie, and may mint a one-hour bearer token
restricted to one event they can read. The email adapter is provider-neutral and configured by
AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN; provider payloads do not enter application contracts.
Runtime actor resolution loads organization memberships and event roles from D1 on every cookie or
bearer request, so persisted revocation takes effect immediately. The current-session query drives
browser navigation, while server authorization remains authoritative. The internal demo-session
route exists only when DEMO_MODE=true under exact ENVIRONMENT=development. Runtime startup rejects
production or demo operation with a missing/default signing secret and rejects demo mode outside
development.

CI proves positive organizer access, scoped reviewer/speaker event reads, public private-route denial/navigation, organization creation denial, cross-event isolation, unauthenticated and unauthorized outcomes, and production demo-mode rejection. Published public reads remain owned by `ACC-PUBLIC`. Every future capability requires corresponding positive/negative tests.

The `crm:manage` capability is granted only to organizers with an assigned event role. CRM application entrypoints require both the actor-level capability and matching event access before any lookup or mutation, so inaccessible prospect identifiers are never enumerated. Reviewer, speaker, public, unauthenticated, and cross-event requests are denied before CRM persistence is invoked.
