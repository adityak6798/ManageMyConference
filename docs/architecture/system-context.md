# System context and flow

Status: canonical | Owner: architecture | IDs: `ARC-001`–`ARC-004` | Last verified: 2026-08-11

`ARC-001` The browser is React/Vite and uses the REST API only. `ARC-002` Hono runs the API on Cloudflare Workers. `ARC-003` D1 stores canonical relational data, and R2 stores assets: the bucket is bound as `ASSETS` in `apps/api/wrangler.toml`, `R2AssetStorage` is wired in `apps/api/src/index.ts`, and speaker uploads and the seeded headshot go through it. `ARC-004` Provider adapters are reached only through application ports. The only one implemented is `DeterministicProvider`, a fake that always succeeds and is what the Worker wires for email, Airtable and Accelevents alike; no adapter sends or writes anything outside this machine (`GAP-010`, `GAP-012`, issue #23).

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
