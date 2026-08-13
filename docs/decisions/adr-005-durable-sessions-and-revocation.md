# ADR-005: Durable session records and revocation

Status: accepted | Owner: identity-access | Date: 2026-08-12

## Context

Until this decision, a Greenroom session was a signed bearer and nothing else: an HMAC over
`{ kind: "session", userId, expiresAt }`, held in an HttpOnly cookie, valid for eight hours from
issue. Nothing server-side knew the session existed. `POST /api/auth/signout` deleted the cookie
from the browser that asked, which is why `signOutResponseSchema` was named `signedOut` and not
`revoked`, and why `docs/architecture/authorization.md` said in as many words that sign-out was
deliberately not revocation.

The consequence is the one that matters. A copy of that cookie — taken from a shared machine, a
synced browser profile, an exfiltrated backup — kept working for the rest of its eight hours no
matter what the person who owned it did. So did any event-scoped bearer token minted from it. The
only remedy was to rotate `SESSION_SECRET`, which signs out every user of the deployment at once.
There was no answer to "I left myself signed in somewhere" that was not "everybody, right now".

`GAP-007` named this, issue #12's first acceptance criterion asks for it, and `ADR-004` deferred
it while Google sign-in landed. This record is the decision it deferred.

## Decision

**An issued session is a row.** `identity_sessions` records `id`, `user_id`, `issued_at`,
`expires_at` and a nullable `revoked_at`. The session cookie carries that row's id as a `sid`
claim; `resolveUserSession` verifies the HMAC, then reads the row, and refuses a credential whose
row is missing, revoked or past its expiry. `POST /api/auth/signout` marks the row revoked before
it clears the cookie, and `POST /api/auth/sessions/revoke-all` marks every live row of one user.

**A server-side record rather than short-lived tokens plus a refresh token.** Both designs make
revocation possible; they differ in what "revoked" means in between. A refresh design keeps access
tokens self-contained and short — five minutes, say — so revocation is really *expiry*, and a
stolen access token stays valid for the rest of its window no matter what the owner does. This
product's answer to "is that session over?" has to be yes immediately, because the person asking
is standing at the machine they left themselves signed in on. A refresh design also adds a second
credential, a second endpoint, a rotation-and-reuse-detection scheme, and a client that must
handle a mid-request refresh — a great deal of machinery whose benefit is fewer database reads,
which is a cost this product has not measured a problem with.

**One indexed read per authenticated request, implemented as its own primary-key lookup.**
`SessionStore.find` is a `SELECT … WHERE id = ? AND revoked_at IS NULL AND expires_at > ?` against
the primary key, issued separately from the actor read that follows it. Folding the two into one
statement is a measured optimization and would be a guess today: the actor read is already several
statements (`users`, `organization_memberships`, `event_roles`), and joining a fourth to save a
round trip trades a clear boundary for an unquantified saving. The port is shaped so that change
stays local if the measurement ever justifies it.

**The signature is verified before D1 is read.** The order is load-bearing rather than tidy: a
resolver that looked the row up first would let an unauthenticated flood of forged cookies become
a stream of database reads, which is a cheaper attack than the one the signature exists to stop.
`real-auth.test.ts` asserts that a wrong signature, a wrong secret, and an expired payload each
cost no lookup at all.

**A token minted before this change is refused.** It carries no `sid`, so there is nothing to look
up, and there is no compatibility window. Everyone signed in at deploy time signs in again once.
The alternative — honour a legacy token until it expires — would leave the exact property this
decision removes in place for a further eight hours, on the deployment where somebody has just
been told that sign-out now works.

**An event bearer token inherits its parent session's revocation.** `createEventToken` carries the
`sid` of the session it was minted from, and `resolveEventToken` refuses it once that session is
gone. Signing out of a browser therefore ends the API access minted from it. That is the right
default for a token whose only issuance path is "I am signed in here, give me a token for this
event" — the token is an extension of that browser's authority, and it should not outlive it. A
client credential that is genuinely independent of a browser session is a different thing with
different lifecycle, rotation and audit needs; issue #100 ("Productize the REST API with scoped
clients") is where it belongs, and this decision deliberately does not pre-build it.

**Every state change is batched with its audit row, and a write that changed nothing writes no
row.** `identity_audit_events` is append-only, and each writer in this domain sends the change and
its record to D1 as one batch. An audit row therefore cannot claim something that did not happen,
and a state change cannot happen unaudited. Because the affected-row count is not known when the
batch is built, the guard is in SQL: the audit insert for a conditional write carries
`WHERE changes() > 0`, and D1 runs a batch as one sequential transaction, so that is the preceding
statement's count. A sign-out that matched no live session is a no-op rather than a refusal — the
caller was denied nothing — so it is not recorded. That distinction is also what keeps the table
hard to grow: `/api/auth/signout` has no throttle, so a row per attempt would let anyone holding a
validly-signed dead cookie append to it at will. For the same reason `sessionIdFrom` refuses a
payload past its expiry, which costs an expired credential nothing it still had.

**A seeded demo persona is never the subject of a real session.** Account linking resolves an
identity by verified address, and `seed/reset.sql` gives the demo personas real addresses — so on
the one deployment that can hold both populations, `DEMO_MODE=true` with Google configured, a real
sign-in as `organizer@greenroom.test` would otherwise mint a real session for `seed-organizer`,
the identity the landing page hands to the next visitor who presses **Continue as organizer**.
Both issuing routes refuse a subject for which `isDemoPersonaId` holds, and that predicate is
derived from the `personas` object's own keys so it cannot drift from the four seeded rows. The
alternative — trusting `GAP-019` to keep Google unconfigured on the demo — is a deployment
convention standing in for an authorization rule.

**The Google callback's refusals are recorded as structured logs, not audit rows.** A refused
sign-in has no state change to batch a row with. Writing one best-effort would give two bad
options — let a failed audit write turn a refusal into a 500, or drop it silently — and a record
that is durable only when nothing goes wrong is not a record. Those refusals stay in
`auth.google.refused`, and `docs/architecture/authorization.md` says where to look for them.

**No credential is ever audited.** No `id_token`, no `code_verifier`, no `state_proof`, no session
token, no cookie value. `detail` carries the shape of an action and never the secret that
authorized it.

## Consequences

- Sign-out means what a person reading the button assumes it means, and "sign out everywhere" is
  now answerable — with a count, because the caller has already proved the identity being counted.
- Every authenticated request costs one more indexed D1 read. A demo persona costs none: a persona
  cookie names no session record, and `docs/architecture/authorization.md` forbids ever giving it
  one.
- The deployment signs everybody out once, at the deploy that lands this.
- `identity_sessions` accumulates rows. Nothing prunes them yet; the expiry index exists so a
  sweep can be added when the table's size is a real number rather than an anticipated one.
- `identity_audit_events` accumulates too, and it is the one with no expiry to sweep on, because
  an audit record's whole value is that it outlives what it describes. What bounds it is that
  only a real state change writes a row: every row costs somebody an authenticated action. That
  is a property of the writers rather than of the table, so it is worth restating whenever a new
  writer is added — a writer that records attempts rather than changes would hand an unbounded
  append to whoever can reach it.
- A session row's `user_id` is now the only user column that is not an actor-resolution route, and
  it must stay that way. The three demo-safety rules in `docs/architecture/authorization.md` state
  it, and `resolveUserSession` compares that column against the signed payload rather than
  following it.

## The seam with issue #99

Issue #99 owns permission-aware global search, an operational inbox, and a **unified audit
timeline** across domains. It needs records that distinguish actor, source, action, target, event,
timestamp and correlation reference. `identity_audit_events` carries exactly those columns, and is
indexed on `(organization_id, occurred_at)` and `(actor_user_id, occurred_at)` so that a timeline
can project it by organization or by account without a migration.

What this lane deliberately does not build: any cross-domain timeline, any shared audit schema for
other domains, and any UI beyond the organization-scoped read that membership administration adds.
Two details are worth #99 knowing in advance. The `action` vocabulary is a SQLite `CHECK`, so
extending it is a table rebuild — which is why the identity lane's whole vocabulary is declared in
`1002_identity_audit_events.sql` rather than one pull request's worth. And `source` admits
`human`, `api` and `system` but not #99's `agent`: identity-access has no agent-initiated action,
and a column admitting a value nothing writes would be a claim this table cannot support. Widening
it belongs to whichever lane first has an agent actor.

## Alternatives considered

- **Short-lived access tokens with a refresh token.** Rejected above: revocation becomes expiry,
  and the machinery buys a saving nobody has measured a need for.
- **A revocation list of session ids, checked in memory.** Cheaper per request, but it is either
  per-isolate — so a revocation is honoured by whichever Worker instance happened to see it — or
  it is a shared store, which is the D1 read this decision already takes, plus a cache to keep
  correct.
- **Revoke by bumping a per-user counter carried in the token.** One read either way, and it
  cannot express "sign out this one device", which is the case people actually ask for.
- **Keep sign-out as cookie clearing and document it honestly.** This is what the repository did
  until now, and the honesty was real. It is not a resting place: `GAP-007` exists because the
  product needs the capability, not because the wording needed fixing.
