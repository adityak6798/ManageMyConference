# System context and flow

Status: canonical | Owner: architecture | IDs: `ARC-001`–`ARC-004` | Last verified: 2026-08-09

`ARC-001` The browser is React/Vite and uses the REST API only. `ARC-002` Hono runs the API on Cloudflare Workers. `ARC-003` D1 stores canonical relational data; R2 is planned for assets and is not configured yet. `ARC-004` Future provider adapters are reached only through application ports; none are implemented yet.

```text
organizer/reviewer/speaker/public browser
              │ HTTPS + JSON
              ▼
        Hono transport layer
              │ validated command/query
              ▼
       application services ─── domain rules
              │ typed ports
       ┌──────┴─────────┐
       ▼                ▼
 D1/R2 adapters   provider adapters
                  email/AI/Airtable/Accelevents
```

Request flow: authenticate → authorize event/role → validate transport input → invoke application service → enforce domain rules → persist atomically → enqueue effects → map result to contract → log correlation outcome. Public reads use published projections, never private entities.
