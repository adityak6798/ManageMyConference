# Security operations

Status: canonical | Owner: security | Last verified: 2026-08-14

What an operator does about credentials, and what happens to the people signed in while they do
it. Everything here is procedure for a live deployment; the design behind it is
[authorization](../architecture/authorization.md),
[`ADR-004`](../decisions/adr-004-google-oauth-provider.md) and
[`ADR-005`](../decisions/adr-005-durable-sessions-and-revocation.md).

## What this deployment is configured with

| Binding | Kind | Where it lives | Absent means |
|---|---|---|---|
| `SESSION_SECRET` | secret | `npx wrangler secret put` | the Worker refuses to boot |
| `SESSION_SECRET_PREVIOUS` | secret | `npx wrangler secret put`, only during a rotation | no rotation is in flight |
| `AUTH_EMAIL_ENDPOINT`, `AUTH_EMAIL_TOKEN` | var, secret | config, `secret put` | the Worker refuses to boot outside demo mode |
| `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI` | vars | `apps/api/wrangler.toml` | Google sign-in answers 404 and `/api/auth/config` reports `google: false` |
| `GOOGLE_CLIENT_SECRET` | secret | `npx wrangler secret put` | with the other two set, the Worker refuses to boot |

One binding pair carries two kinds of message. `AUTH_EMAIL_ENDPOINT`/`AUTH_EMAIL_TOKEN` sends the
emailed sign-in code and, since issue #196, a scheduled report's expiring link — one provider
credential, two audiences, so revoking it stops sign-in as well as reporting. Absent, the tick
records the report run as `failed` rather than as sent, deliberately, because an unconfigured
deployment must not look like a working one. The report send carries a link and an expiry and
never any rows, which is why it is acceptable on a mail path at all — see
[`ADR-006`](../decisions/adr-006-field-access-and-capability-links.md).

The Google bindings are **all three or none**: `resolveGoogleConfiguration` refuses a partial
configuration by name at boot, because a deployment that offers a sign-in button it cannot complete
is worse than one that offers none.

### Enabling Google sign-in on the deployed demo, or rotating the client

The client id and redirect URI are set in `apps/api/wrangler.toml`; the secret is a Worker secret.
They were withheld until `GAP-019` closed, because the demo restore would have erased the first
person to sign up — it now counts the rows the seed did not create and refuses rather than deleting
them. These are the steps that made them live, and the ones to repeat if the client is rotated. All
four are operator actions, because two of them carry credentials:

1. **Create the OAuth client.** Google Cloud console → Credentials → OAuth 2.0 client ID → *Web
   application*. Register exactly this redirect URI against it:
   `https://project-greenroom-api.adityak6798.workers.dev/api/auth/google/callback`. It must match
   byte for byte, and it is configuration rather than anything derived from a request — a redirect
   URI a caller can name is the open redirect.
2. **Set the two vars.** Put the client's own id in `GOOGLE_CLIENT_ID` in
   `apps/api/wrangler.toml`, leaving the redirect URI as written.
3. **Deploy.** `npm run deploy` from the repository root, or merge to `main` and let CI run it.
   Putting the client id in `[vars]` also reaches every *local* run, because `wrangler dev` reads
   the same file: `npm run setup:local` writes the three bindings blank into the gitignored
   `.dev.vars`, which overrides them, so a development machine with no secret is not left holding
   two of the three. See [local development](local-development.md#google-sign-in-configuration).
4. **Put the secret, immediately.** `cd apps/api && npx wrangler secret put GOOGLE_CLIENT_SECRET`.
   Then check `/api/auth/config` reports `google: true` and complete one real sign-in. That
   sign-in is what proves the client: `GAP-020` recorded that no request had ever reached Google
   and was closed on 2026-08-14 by the first one. A rotation does not reopen it; a client that
   cannot complete a sign-in is the thing this step exists to catch, and the reason is in the
   Worker log as `auth.google.failed` with a correlation id rather than on screen.

**Steps 3 and 4 are one operation, and the deployment is down in between.** All three bindings are
one unit, `resolveGoogleConfiguration` refuses a partial configuration by name, and it runs inside
`fetch` — so a Worker holding two of the three answers 500 to every request, `/health` and the demo
personas included. A secret cannot be part of a deploy, so nothing makes them atomic; this order is
simply the short way round, because a `secret put` takes seconds and a deploy takes minutes. Doing
it the other way leaves the deployment failing for the whole length of a build. If step 4 fails,
`npx wrangler secret delete GOOGLE_CLIENT_SECRET` restores service at once by returning the Worker
to none of the three.

Two consequences to expect rather than discover. A Google identity whose verified address is a
**seeded persona address** (`organizer@greenroom.test` and the rest) is refused and logged as
`auth.google.refused`, because linking it would hand a real session to whoever presses *Continue as
organizer* next. And once anyone signs up there, `npm run reset:demo` refuses until either those
rows are gone or the operator names them explicitly — see the restore section of the
[demo runbook](../demo-runbook.md#restore-the-deployed-demo).

## Rotating `SESSION_SECRET`

Rotating used to mean signing every user out at the instant of the deploy, which is why nobody
could safely do it. `SESSION_SECRET_PREVIOUS` is the window that removes that cost: issuance always
uses `SESSION_SECRET`, verification tries it and then the previous one.

1. **Set the previous secret to the current value.**
   `npx wrangler secret put SESSION_SECRET_PREVIOUS` — paste the value `SESSION_SECRET` holds now.
2. **Set the current secret to the new value.**
   `npx wrangler secret put SESSION_SECRET` — paste a fresh high-entropy value.
3. **Deploy.** From this moment new sessions are signed with the new secret and existing ones keep
   verifying under the old one.
4. **Wait one full session lifetime — eight hours** (`SESSION_LIFETIME_MS` in
   `apps/api/src/transport/http/routes/identity.ts`). Every session that predates the rotation has
   expired by then.
5. **Unset the previous secret.** `npx wrangler secret delete SESSION_SECRET_PREVIOUS`, then
   deploy. Anything still holding a token signed with the old secret is now refused.

The boot guard refuses two configurations that look like a rotation and are not: a previous secret
equal to the current one (nothing has moved, and unsetting it after the window would leave the old
secret live), and the `local-development-secret` placeholder. Both fail the deploy by name.

**What the window does not cover.** A Google sign-in *in flight* — begun but not yet returned from
— carries a `state` proof signed with the secret in force when it started, and that proof is
checked against the current secret only. An attempt lives ten minutes (`ATTEMPT_LIFETIME_MS` in
`application/identity/google-oauth.ts`), so the entire exposure is that sign-ins begun in the ten
minutes before step 3 fail their `state` check and the person presses the button again. Carrying a
second secret through the attempt table would cost more than that is worth. Emailed codes *are*
covered: the code's proof is re-derived under whichever secret verified its challenge.

Demo persona cookies are signed with the same secret and get the same dual verification, so
rotating does not empty the demo either.

## Rotating `GOOGLE_CLIENT_SECRET`

The only in-flight state is a token exchange, and an attempt expires in ten minutes.

1. Create the new client secret in the Google Cloud console, leaving the old one active.
2. `npx wrangler secret put GOOGLE_CLIENT_SECRET` with the new value, and deploy.
3. Wait ten minutes, so any attempt begun against the old secret has expired.
4. Delete the old secret in the Google Cloud console.

Sign-ins that were mid-exchange during step 2 fail and land on `/signin?auth=failed`; the person
signs in again. **No existing session is affected** — the client secret authenticates this
deployment to Google, and has nothing to do with the cookies already issued.

Rotating `GOOGLE_CLIENT_ID` or `GOOGLE_REDIRECT_URI` is a different operation: they are vars, the
redirect URI must match what is registered against the client, and changing either without the
other is the partial configuration the boot guard refuses.

## Incident revocation

For when the console is not the right instrument — a leaked backup, a compromised device, an
account that must be shut off now.

```
npm run revoke:sessions -- --confirm <worker-name> --user <id>
npm run revoke:sessions -- --confirm <worker-name> --all
```

`--confirm` must name the worker in `apps/api/wrangler.toml`, so copying the command into a shell
pointed at another deployment fails closed rather than acting on the wrong database. Exactly one of
`--user` and `--all` is required. A user id must be a plain identifier — the id is interpolated
into SQL, because `wrangler d1 execute` takes a command string rather than bound parameters, so
anything else is refused rather than escaped. Add `--local` to act on the local development
database.

A run that revokes something writes a `session.revoked_all` audit row with `source = 'system'` and
prints the correlation id that row carries, which is how the action is found afterwards. A run that
revoked *nothing* writes no row: the revocation runs first and the audit insert is guarded on its
affected-row count, so neither a failed statement nor a zero-row sweep leaves a record claiming a
revocation happened.

**What revocation does and does not reach.** It ends sessions, and with them every event bearer
token minted from one. It does not change memberships, roles or passwords, and it does not stop the
person signing in again — if the account itself is the problem, remove its memberships and event
roles through the members workspace first, which takes effect on their next request.

A person can do the same thing to their own sessions without an operator: **Sign out everywhere**
in the console, or `POST /api/auth/sessions/revoke-all`.

## Recovery

**Somebody has lost access to their Google account.** They sign in through the emailed-code door on
the same verified address. Both doors resolve the same identity, so their memberships, event roles
and workspace are unchanged. What makes this safe rather than an account-takeover primitive is the
linking rule: a provider account matches on the provider's own stable subject first, and failing
that on a **verified** address only — an unverified address is refused outright. Somebody who
controls the mailbox is the person the address belongs to; somebody who merely claims the address
is not.

**Somebody has lost access to their email address.** There is no recovery path today, and that is
worth stating plainly rather than implying one exists. Both doors resolve identity through the
address. An operator can link a new address to the existing user id directly in the directory, and
that is an out-of-band action requiring database access, deliberately.

**An organization has no remaining organizer.** This is reachable: the last organizer can remove
themselves, and nothing refuses it. Nobody can then administer that organization — the membership
routes need `identity:manage` earned inside it — and its events keep working for everybody already
staffed on them. Recovery is an operator granting the organizer role directly:

```sql
INSERT OR IGNORE INTO organization_memberships (organization_id, user_id, role)
  VALUES ('<organization-id>', '<user-id>', 'organizer');
INSERT OR IGNORE INTO event_roles (event_id, user_id, role)
  VALUES ('<an-event-of-that-organization>', '<user-id>', 'organizer');
```

Both rows are needed: membership alone does not satisfy the third authorization condition, which is
that the capability was earned on an event belonging to the organization. Write an
`identity_audit_events` row alongside them naming what was done and why — an operator write that
leaves no trace is the one an audit log cannot explain later.

Refusing the last organizer's own removal would be the better product, and is not implemented; it
is the kind of guard that needs a decision about what happens to an organization nobody wants.

## What is not covered here

Provider credentials for communications and the AI review port have their own documents:
[communications providers](communications-providers.md) and
[review suggestions](review-suggestions.md).
