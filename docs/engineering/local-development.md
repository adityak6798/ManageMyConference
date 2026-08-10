# Local development

Status: canonical | Owner: developer experience | ID: `ENG-DEV-001` | Last verified: 2026-08-09

The current scaffold provides install/start, local D1 migration/reset, and the same aggregate check entrypoint used by CI. The API defaults to port `8787` and accepts `GREENROOM_API_PORT`; Vite defaults to `5173` and accepts `GREENROOM_WEB_PORT`. Worktree ports are not auto-allocated. Seeded demo personas establish expiring signed HttpOnly sessions for organizer, reviewer, speaker, and public behavior; they exercise the same application authorization as ordinary requests. Demo auth is harness-only and requires both `DEMO_MODE=true` and the exact `ENVIRONMENT=development`; missing, misspelled, and non-development environments fail closed. R2 setup is planned.

Implemented commands:

- `npm ci`
- `npm run setup:local`
- `npm run dev`
- `npm run reset`
- `npm run check`
- `npm test`
- `npm run test:d1 --workspace @greenroom/api`
- `npm run test:e2e`
- `npm run openapi:generate`
- `npm run context -- task <ID>`

`npm run setup:local` creates `apps/api/.dev.vars` only when absent, using a random session key; the file is ignored and must never be committed or reused as a deployment secret. The API `/health` response is validated by the shared Zod contract and reports configured database/session-signing checks, deterministic-fake provider mode, and structured-JSON log format. It does not query migration state or expose personas or log paths. Requests emit structured completion/denial/exception logs with correlation ID, method, path, status, duration, and safe actor ID. Unexpected failures are logged once at the transport ownership boundary before safe conversion. Wrangler writes local API logs under `apps/api/.wrangler/`. Health and logs must never contain session secrets or cookies.
