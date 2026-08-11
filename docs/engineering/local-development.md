# Local development

Status: canonical | Owner: developer experience | ID: `ENG-DEV-001` | Last verified: 2026-08-11

The current scaffold provides install/start, local D1 migration/reset, local R2-backed speaker uploads, and the same aggregate check entrypoint used by CI. Seeded demo personas establish expiring signed HttpOnly sessions for organizer, reviewer, speaker, and public behavior; they exercise the same application authorization as ordinary requests. Demo auth is harness-only and requires both `DEMO_MODE=true` and the exact `ENVIRONMENT=development`; missing, misspelled, and non-development environments fail closed.

Implemented commands:

- `npm ci`
- `npm run setup:local`
- `npm run worktree:status`
- `npm run dev`
- `npm run reset` (and `npm run reset -- --rebuild`)
- `npm run check`
- `npm test`
- `npm run test:d1 --workspace @greenroom/api`
- `npm run test:e2e`
- `npm run openapi:generate`
- `npm run context -- task <ID>`

## Ports and local state are per instance

Ports are **derived from the checkout path**, not defaulted, so two worktrees run `npm run dev` or the Playwright suite at the same time without anyone being told which ports are free. `tools/worktree-env.mjs` hashes the worktree root into one block of two adjacent ports in `20000`–`20999` — above every port this repository used to default to, below the ephemeral range the kernel allocates from. `GREENROOM_API_PORT` and `GREENROOM_WEB_PORT` still override, and an unusable value is refused by name rather than silently coerced.

Local D1 and R2 state is keyed on the **API port**, not on the checkout:

```text
apps/api/.wrangler/instances/<api-port>/
  state/                    local D1 and R2
  config/                   wrangler's XDG config home
  wrangler.log              this instance's log
  migration-identity.json   which migrations built this database
```

Per-worktree was not enough, and `GAP-004` records the measurement: two `wrangler dev` processes of *one* worktree on different ports shared a single `apps/api/.wrangler/state/v3/d1` file, and the browser suite then failed intermittently — a different single spec each time, none reproducible alone. Keying on the port makes an instance, not a checkout, the owner of its database. Everything under `.wrangler/` is ignored by git and safe to delete; `npm run worktree -- clean` removes this instance's directory and nothing else.

Run `npm run worktree:status` to see the resolved ports and paths, whether each port is derived or overridden, and whether the migrations that built this database still match the ones in the repository. It never prints the contents of `apps/api/.dev.vars`.

## When local state and the migrations disagree

`npm run reset` and `npm run dev` refuse to run against a database the current migrations can no longer explain, and name what diverged:

```text
Local D1 state at …/instances/20192/state was migrated from a different migration set.
  - applied here but no longer in the repository: 0099_example.sql

Applying migrations cannot repair either case, so this database no longer matches the
schema the repository describes. Rebuild it:

  npm run reset -- --rebuild
```

Only two things count as divergence: a migration that was applied here and has since been deleted, and one whose contents changed after it was applied. Neither can be fixed by applying anything, which is why the reset stops instead of continuing. **Adding** a migration is the ordinary forward case and is not a conflict — the next reset applies it. `--rebuild` deletes this instance's directory and rebuilds it from scratch; other worktrees and other ports are untouched.

`npm run setup:local` creates `apps/api/.dev.vars` only when absent, using a random session key; the file is ignored and must never be committed or reused as a deployment secret. The API `/health` response is validated by the shared Zod contract and reports configured database/session-signing checks, SQL/R2 provider mode, and structured-JSON log format. It does not query migration state or expose personas or log paths. Requests emit structured completion/denial/exception logs with correlation ID, method, path, status, duration, and safe actor ID. Unexpected failures are logged once at the transport ownership boundary before safe conversion. Wrangler writes local API logs to this instance's `apps/api/.wrangler/instances/<api-port>/wrangler.log`, which `npm run worktree:status` prints. Health and logs must never contain session secrets or cookies.
