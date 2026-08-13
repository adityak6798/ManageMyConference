# Local development

Status: canonical | Owner: developer experience | ID: `ENG-DEV-001` | Last verified: 2026-08-12

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

## A test run proves whose server it is talking to

Outside CI Playwright reuses any server already answering the port it wants, whoever started it. Derived ports stop two checkouts *colliding*; they do not stop a run that names a port from adopting a stranger already on it, and an override is exactly where that bites. On 2026-08-11 port 8787 was held by a `workerd` from a different clone, and a suite run from this checkout made every API assertion against that clone's code — reporting a confident 16/19, with three "failures" that had nothing to do with the branch under test.

So `/health` now reports which checkout started the Worker and at which commit:

```json
{ "status": "ok", "build": { "root": "/…/ManageMyConference", "commit": "2ed438d…" } }
```

Both values are non-secret by construction — a filesystem path and a commit SHA. The launcher supplies them; a deployment omits the `build` object entirely. The same document is served at `/api/health` so a caller behind the web dev server's `/api` proxy can read the identity of the API it actually reaches.

`apps/web/e2e/global-setup.ts` checks both before any spec runs:

- **A different checkout's root is fatal.** The run aborts naming both paths, and no spec executes.
- **A server that reports no identity at all is fatal.** It was not started by the launcher, so there is no way to tell whose it is. Start servers with `npm run dev`.
- **A different commit on the same checkout warns and continues.** `wrangler dev` reloads source on change, so a server started three commits ago is serving the working tree as it is now; aborting would be a false alarm in the ordinary edit-and-rerun loop. The case where a stale process genuinely matters — its database was built from different migrations — is caught precisely by the migration identity check below rather than guessed at from a SHA.

In CI `reuseExistingServer` is false, the suite starts its own servers, and the check passes against them.

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

`npm run setup:local` creates `apps/api/.dev.vars` only when absent, using a random session key; the file is ignored and must never be committed or reused as a deployment secret. The API `/health` response is validated by the shared Zod contract and reports configured database/session-signing checks, SQL/R2 provider mode, structured-JSON log format, and — locally only — the build identity described above. It does not query migration state or expose personas or log paths. Requests emit structured completion/denial/exception logs with correlation ID, method, path, status, duration, and safe actor ID. Unexpected failures are logged once at the transport ownership boundary before safe conversion. Wrangler writes local API logs to this instance's `apps/api/.wrangler/instances/<api-port>/wrangler.log`, which `npm run worktree:status` prints. Health and logs must never contain session secrets or cookies.

## Google sign-in configuration

Google sign-in is off unless three bindings are present, and it is all three or none — a partial
configuration fails the Worker's boot by name rather than breaking somebody's first sign-in:

| Binding | What it is | Where it lives |
|---|---|---|
| `GOOGLE_CLIENT_ID` | The OAuth client's public identifier | `apps/api/.dev.vars` locally; `[vars]` in `wrangler.toml` for a deployment |
| `GOOGLE_CLIENT_SECRET` | **A credential.** Never committed, never in `wrangler.toml` | `apps/api/.dev.vars` locally; `npx wrangler secret put GOOGLE_CLIENT_SECRET` for a deployment |
| `GOOGLE_REDIRECT_URI` | The exact URI Google will send the browser back to | Same places as the client id |

`npm run setup:local` does not write any of them, and it never overwrites an existing `.dev.vars`,
so add them by hand to the file it created. **With no Google bindings the application behaves
exactly as it did before**: `GET /api/auth/config` reports `google: false`, both Google routes
answer 404, and every other door — demo personas locally, emailed codes in a configured production
— is untouched. Nothing about local development requires this section.

### Register the redirect URIs before expecting sign-in to work

Google refuses an authorization request whose `redirect_uri` is not registered against the OAuth
client, and refuses the token exchange for the same reason. **Until the URI is registered in the
Google Cloud console, Google sign-in does not work** — the browser gets Google's own error page,
not ours, and no amount of local configuration changes that.

Two URIs, one per place this repository runs:

```text
https://project-greenroom-api.adityak6798.workers.dev/api/auth/google/callback
http://127.0.0.1:20192/api/auth/google/callback
```

The deployed one is fixed. **The local one is not: `20192` is one checkout's derived port, not a
default** — the worktree this section was written in resolved to `20784`. Ports here are hashed
from the worktree path (see
[ports and local state](#ports-and-local-state-are-per-instance) and `tools/worktree-env.mjs`), so
your checkout almost certainly resolves to a different one. Run `npm run worktree:status`, read the
API port it reports, and register `http://127.0.0.1:<that port>/api/auth/google/callback` as an
additional authorized redirect URI — a Google OAuth client accepts a list, so one client can carry
the deployed URI and every contributor's local one. The alternative is to set
`GREENROOM_API_PORT` to a port that is already registered, which trades a console edit for an
override you must remember; either is fine, and mixing them is what produces a
`redirect_uri_mismatch` nobody can explain.

Use `127.0.0.1` rather than `localhost` and match it in `GOOGLE_REDIRECT_URI` exactly. Google
compares the string, so the two spellings are two different registrations even though the browser
reaches the same server.

The port in that URI is the **API** port, not the web one, because the callback is a Worker route
and Google navigates the browser straight to it rather than through the Vite proxy. A sign-in
started on the web dev server still completes: cookies are scoped to a host and ignore the port, so
the `greenroom_oauth` attempt cookie set on `127.0.0.1` at one port arrives at the other, and the
session cookie the callback sets comes back the same way.
