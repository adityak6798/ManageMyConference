# Registering a domain

Status: canonical | Owner: platform architecture | ID: `ARC-DOM-001` | Last verified: 2026-08-11

A domain puts itself on each surface by writing its own module and adding **one line** to that
surface's registry. It does not edit another domain's module, and it does not edit a file that
holds every domain's code.

That was not true before. `apps/api/src/transport/http/app.ts` held all 57 routes and an error
handler naming every domain's error classes; `apps/web/src/App.tsx` held a per-persona route
table, an icon map and a `renderPage` switch; `packages/contracts/scripts/generate-openapi.ts`
held all 56 path definitions; `context-manifest.json` held every domain's context. Seven
feature branches were editing all four, and each merge between them was a manual conflict
resolution over code neither branch had changed the meaning of.

## The four surfaces

| Surface | Your module | The one line |
|---|---|---|
| HTTP routes | `apps/api/src/transport/http/routes/<domain>.ts` | `routeModules` in [`routes/registry.ts`](../../apps/api/src/transport/http/routes/registry.ts) |
| Console workspace | `apps/web/src/workspaces/<domain>.tsx` | `workspaceModules` in [`workspaces/registry.tsx`](../../apps/web/src/workspaces/registry.tsx) |
| OpenAPI paths | `packages/contracts/openapi/<domain>.ts` | `openApiFragments` in [`openapi/registry.ts`](../../packages/contracts/openapi/registry.ts) |
| Context metadata | `context/domains/<domain>.json` | none — the directory *is* the registry |

Everything else — the aggregate `context-manifest.json`, the generated context index, and
`openapi.json` — is generated. Run `npm run context -- generate` and
`npm run openapi:generate`; both are byte-stable, so regenerating twice changes nothing.

## HTTP routes

Implement [`RouteModule`](../../apps/api/src/transport/http/routes/contract.ts):

```ts
export const exampleRoutes: RouteModule = {
  domain: "example",
  routes: ["GET /api/events/:eventId/example"] as const,
  register(app, { events, example }) {
    app.get("/api/events/:eventId/example", async (context) => { /* … */ });
  },
  translateError(error) {
    if (error instanceof ExampleNotFoundError)
      return { code: "NOT_FOUND", message: "…", status: 404 } as const;
    return null;
  },
};
```

- **`routes` is declared, not discovered.** Two domains claiming one route is a merge accident;
  Hono would let the first registration win and the other would simply never run. Declaring the
  table makes it a construction-time failure naming both domains, and
  `npm run context -- check` names them before anyone starts a server.
- **`translateError` keeps the error handler out of the middle.** `app.ts` translates only the
  transport-wide refusals — unauthenticated, forbidden, malformed JSON. Everything else is its
  own domain's, so adding a domain adds no case to a shared `onError`.
- **Services arrive by name**, through
  [`HttpDependencies`](../../apps/api/src/transport/http/routes/contract.ts). They are optional
  because a test may compose only the domains it exercises; a module whose service is absent
  must degrade to its documented not-found behaviour rather than throw.

## Console workspace

Implement [`WorkspaceModule`](../../apps/web/src/workspaces/contract.ts). It declares its route,
sidebar label, icon, group and order, the personas that see it, an optional capability gate,
and its header — so `App.tsx` derives the sidebar and dispatches without knowing the domain
exists.

Keep `personas` and `canAccess` distinct. `personas` decides what appears in the sidebar;
`canAccess` decides whether opening it works. An organizer sees every organizer surface listed
even where a capability is missing, and opening one then explains the refusal instead of hiding
that it exists. Gate inside your workspace component as well: the route-allowlist redirect is an
effect, so it runs *after* children mount and fire their requests.

## OpenAPI paths

Implement [`OpenApiFragment`](../../packages/contracts/openapi/contract.ts). `json` and
`errorResponse` are supplied rather than re-declared. The generator sorts paths before writing,
so adding a fragment produces a diff of exactly your own paths rather than reshuffling the
artifact, and a path claimed by two fragments fails generation with both domains named.

## Context metadata

Write `context/domains/<domain>.json`:

```json
{
  "id": "example",
  "order": 110,
  "index": "docs/product/specifications.md",
  "specs": ["PRD-EXA-001"],
  "journeys": [],
  "acceptance": ["ACC-EXAMPLE"],
  "plans": ["PLAN-002"],
  "paths": ["apps/api/src/application/example"],
  "symbols": { "ExampleService": "apps/api/src/application/example/example-service.ts" }
}
```

`order` is this domain's position in the aggregate, declared here so adding a domain edits no
shared file. Every declared path must exist, must not overlap another domain's, and every
identifier must have a normative definition in a document. A symbol registered by two domains
fails the check with both named.

## Contracts, storage and seed data

Each domain owns the same three declarations outside its runtime module:

- Zod contracts in `packages/contracts/src/domains/<domain>.ts`, re-exported by the stable
  `packages/contracts/src/index.ts` entrypoint;
- Drizzle tables in `apps/api/src/adapters/persistence/schema/<domain>.ts`, registered in
  `schema/registry.ts` and re-exported by `schema.ts`;
- deterministic SQL fragments under `apps/api/seed/domains/<domain>/`, listed in
  `tools/compose-seed.mjs` in dependency-safe application order.

Run `npm run seed:generate` after changing a seed fragment. The composed `seed/reset.sql` remains
the one artifact consumed by local reset and the D1 test harness, while `npm run seed:check`
refuses aggregate drift. Add all three domain-owned paths to `context/domains/<domain>.json`.

New migrations use the domain blocks in
[`apps/api/migrations/README.md`](../../apps/api/migrations/README.md), so parallel changes cannot
independently claim the same globally ordered filename.

## Boundaries still apply

Modularisation does not widen anything. Dependencies still point
`domain -> application -> adapters/transport`, and a cross-domain import still has to go through
a declared public application interface — see [domain boundaries](../architecture/domain-boundaries.md).

Two entries in the architecture allowlists exist to serve this structure, and both are shared
interfaces rather than exemptions from one:

- `apps/api/src/transport/http/runtime.ts`, `routes/contract.ts` and `throttle.ts`, plus
  `apps/web/src/workspaces/contract.ts`, are the vocabulary every domain module imports — the
  request context, the error envelope, the dependency interface. They contain no domain logic.
- `routes/registry.ts` and `workspaces/registry.tsx` are composition roots. Listing every
  domain is the whole of what they do.

If you find yourself adding a path to either allowlist to make a check pass, that is the signal
to fix the import instead.

## What to run

```bash
npm run context -- generate     # aggregate manifest + generated index
npm run openapi:generate        # aggregate OpenAPI document
npm run check
```
