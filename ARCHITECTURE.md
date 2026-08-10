# Project Greenroom Architecture

**Status:** normative
**Owner:** platform
**Last verified:** 2026-08-09
**Governing ADRs:** ADR-001, ADR-002, ADR-003

Project Greenroom is a multi-event conference operations product with organizer, reviewer, speaker, and public experiences. The deployed shape is a React client and Hono Worker API backed by D1 and R2.

## Dependency rule

```text
domain -> application -> adapters -> transport/UI
```

The arrow means “is depended on by.” Domain modules import no framework, transport, database, Cloudflare, or provider SDK. Application services coordinate domain contracts and ports. Adapters implement those ports. Transport and UI translate external input/output.

Each product area owns its tables. Other areas use exported application interfaces or declared events, never direct table reads. `shared` is restricted to approved primitives: identifiers, time, result/error types, and correlation metadata.

## Context and authority

- Product specs own intent, business behavior, and acceptance criteria.
- Zod runtime schemas own HTTP validation and generate OpenAPI.
- Domain types own internal semantics.
- Drizzle schemas describe intended storage; immutable SQL migrations own deployment history.
- Tests own executable evidence, not product intent.
- Generated indexes are disposable projections of approved metadata and trusted repository facts.

Read the detailed [system context and flows](docs/architecture/system-context.md), [domain boundaries](docs/architecture/domain-boundaries.md), and [data flows](docs/architecture/data-flows.md).
