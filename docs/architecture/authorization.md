# Authorization

Status: canonical | Owner: security | ID: `ARC-AUTH-001` | Last verified: 2026-08-09

Authentication establishes identity; application authorization establishes organization/event scope and capability. Route visibility is convenience, never enforcement.

- Organizer: administer assigned organization/events and private event data.
- Reviewer: read assigned submission context and write only their own evaluations.
- Speaker: read/update their own event-scoped profile, tasks, assets, and sessions permitted for collaboration.
- Public: read published projections only.

Every protected application entrypoint receives actor plus event scope and denies by default. Object lookups include tenant scope to prevent enumeration. Logs and errors do not reveal whether an inaccessible record exists.

The current seeded demo authentication is harness-only. `npm run setup:local` creates an ignored `apps/api/.dev.vars` with a random signing secret; no deployable secret is committed. The internal demo-session route exists only when `DEMO_MODE=true`, issues an expiring signed HttpOnly/SameSite cookie, rejects expired or tampered tokens, and still uses normal application authorization. Runtime startup rejects demo mode in production and rejects a missing/default signing secret. Production authentication is intentionally not designed by this harness and requires an assigned security decision before implementation.

CI currently proves positive organizer access plus unauthenticated and reviewer/speaker forbidden outcomes for the reference slice, including production demo-mode rejection. Every future capability requires corresponding positive/negative tests and every event-owned repository requires cross-event isolation tests when tenancy is introduced.
