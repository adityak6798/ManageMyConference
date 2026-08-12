# System context and flow

Status: canonical | Owner: architecture | IDs: `ARC-001`–`ARC-004` | Last verified: 2026-08-12

`ARC-001` The browser is React/Vite and uses the REST API only. `ARC-002` Hono runs the API on Cloudflare Workers. `ARC-003` D1 stores canonical relational data, and R2 stores assets: the bucket is bound as `ASSETS` in `apps/api/wrangler.toml`, `R2AssetStorage` is wired in `apps/api/src/index.ts`, and speaker uploads and the seeded headshot go through it. `ARC-004` Provider adapters are reached only through application ports. Both directions now have real HTTP adapters — outbound for email, Airtable and Accelevents, inbound for reading Accelevents registrations — selected by `COMMUNICATIONS_PROVIDERS`. `fixture` is the default and wires deterministic in-repository fakes, which is what keeps local development, CI, Playwright and the demo offline and credential-free; `live` requires every credential and throws naming the missing bindings rather than falling back to a fake. **No adapter in either direction has ever exchanged a request with its real API**: no credential for any provider exists in this repository, every adapter test stubs `fetch`, and the staging smoke has not run (`GAP-010`, `GAP-012`, issue #23).

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
