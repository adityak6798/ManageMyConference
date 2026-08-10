# ADR-001: Cloudflare TypeScript architecture

Status: accepted | Owner: architecture | Date: 2026-08-09

## Decision

Use React/Vite for the browser, Hono on Cloudflare Workers for REST, D1/Drizzle for relational data, R2 for assets, Zod-generated OpenAPI, and a tooling-only Python/uv workspace. React/Vite, Hono, D1 migration/reset and Miniflare test, Drizzle schema, Zod-generated OpenAPI, and Python/uv tooling are implemented. R2 remains planned until asset workflows exist.

## Consequences

Product runtime stays TypeScript end-to-end. Cloudflare dependencies remain in adapters. Python supports validation/evaluator utilities and cannot become a second product backend.
