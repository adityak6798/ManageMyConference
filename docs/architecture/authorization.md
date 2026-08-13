# Authorization

Status: canonical | Owner: security | ID: `ARC-AUTH-001` | Last verified: 2026-08-12

Authentication establishes identity; application authorization establishes organization/event scope and capability. Route visibility is convenience, never enforcement.

- Organizer: administer assigned organization/events and private event data.
- Reviewer: read assigned submission context and write only their own evaluations.
- Speaker: read/update their own event-scoped profile, tasks, assets, and sessions permitted for collaboration.
- Public: read published projections only.

Every protected application entrypoint receives actor plus event scope and denies by default. Object lookups include tenant scope to prevent enumeration. Logs and errors do not reveal whether an inaccessible record exists.

Actor-wide capabilities are a navigation and organization-level convenience: they are the union
of grants an actor holds and may authorize operations that genuinely have no event, such as
creating an event in an organization. Event-owned reads and mutations use
`requireEventCapability`, which considers every role grant on the named event and requires the
capability on that exact grant. An actor-wide capability never substitutes for the event grant.

The seeded demo authentication is harness-only. Production users request an emailed six-digit code,
exchange it for an expiring signed HttpOnly/SameSite cookie, and may mint a one-hour bearer token
restricted to one event they can read. The email adapter is provider-neutral and configured by
AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN; provider payloads do not enter application contracts.
Runtime actor resolution loads organization memberships and event roles from D1 on every cookie or
bearer request, so persisted revocation takes effect immediately. The current-session query drives
browser navigation, while server authorization remains authoritative. The internal demo-session
route exists only when DEMO_MODE=true under exact ENVIRONMENT=development. Runtime startup rejects
production or demo operation with a missing/default signing secret and rejects demo mode outside
development.

CI proves positive organizer access, scoped reviewer/speaker event reads, public private-route denial/navigation, organization creation denial, cross-event isolation, unauthenticated and unauthorized outcomes, and production demo-mode rejection. Published public reads remain owned by `ACC-PUBLIC`. Every future capability requires corresponding positive/negative tests.

The `crm:manage` capability is granted only to organizers with an assigned event role. CRM application entrypoints require both the actor-level capability and matching event access before any lookup or mutation, so inaccessible prospect identifiers are never enumerated. Reviewer, speaker, public, unauthenticated, and cross-event requests are denied before CRM persistence is invoked.

## Google sign-in is a second door onto the same session

`GET /api/auth/google/start` mints one attempt and redirects the browser to Google;
`GET /api/auth/google/callback` is where it returns. What survives that round trip is a row in
`identity_oauth_attempts` and a short-lived `greenroom_oauth` cookie holding nothing but that row's
id. The CSRF `state` is 32 random bytes, and only its HMAC is stored, so a read of the attempts
table cannot forge a callback; the PKCE `code_verifier` never reaches the browser at all, which is
what makes an intercepted authorization code worthless; the `nonce` is checked against the
`id_token` claim, which is what stops a token minted for another session being replayed into this
one. The attempt is spent by a `DELETE … RETURNING` *before* the code is exchanged, so a callback
that later fails verification has still consumed its one use and a stolen `state` cannot be retried
against a different code.

The `id_token` is verified rather than decoded: RS256 pinned rather than read from the header,
signature checked against the key Google publishes for the `kid`, then issuer, audience, expiry and
`nonce`, and only then are `sub`, `email`, `email_verified` and `name` read. Linking is on
`(provider, subject)` first and on a **verified** address second; an unverified address is refused,
because linking on a claimed address hands an attacker whatever memberships and event roles the
claimed identity holds. A verified identity matching neither is provisioned an organization, a
first event and the organizer role on it, through the events domain's own service rather than by
writing its tables. Every refusal in the flow — unknown attempt, wrong `state`, expired, bad
signature, unverified address — redirects to one destination and logs its reason, so the callback
is not an oracle. The redirect targets are string literals; nothing in the request decides where the
browser goes next.

Three bindings configure the door, all three or none: `GOOGLE_CLIENT_ID` and `GOOGLE_REDIRECT_URI`
are vars, `GOOGLE_CLIENT_SECRET` is a Worker secret. Runtime startup refuses a partial
configuration by name, exactly as it refuses a missing or default `SESSION_SECRET`, and an absent
configuration means the routes answer 404 and `GET /api/auth/config` reports `google: false` — a
door this deployment does not have is a route that does not exist rather than a feature having a
bad day. The redirect URI is deployment configuration and is passed into both the authorization
request and the token exchange; it is never read from a request parameter, which is the open
redirect this route would otherwise be. The client secret reaches only the composition root: the
transport is handed a provider object with `start`, `complete` and `resolveUserActor` on it, so no
route module can log or echo a credential.
[`ADR-004`](../decisions/adr-004-google-oauth-provider.md) records why Google is an additional
provider rather than a replacement, and why the protocol is spoken with raw `fetch`.

## Sessions are records, and sign-out revokes them

An issued session is a row in `identity_sessions` — `id`, `user_id`, `issued_at`, `expires_at`, a
nullable `revoked_at` — and the session cookie carries that row's id as a `sid` claim.
`resolveUserSession` verifies the HMAC **first** and reads the row **second**, in that order, so an
unauthenticated flood of forged cookies cannot be turned into a stream of database reads. A
credential whose row is missing, revoked, or past its expiry is refused. A token minted before
session records existed carries no `sid` and is refused outright; there is no compatibility
window, because accepting one would leave the pre-revocation property in place for a further
session lifetime.

Sign-out is `POST /api/auth/signout`. It marks the row revoked and *then* clears the cookie, so a
copy of the same cookie taken from another device stops working on its next request, as does any
event-scoped bearer token minted from that session — the bearer carries its parent session's `sid`
and is refused with it. It still answers 200 whether or not a session was present, and still
reports no count, because either would tell an unauthenticated caller whether the cookie it
presented was real.

`POST /api/auth/sessions/revoke-all` is "sign out on every device". It requires
`authentication === "session"` — a demo persona cookie resolves as `demo` and is refused — and
answers `{ revoked: <count> }`, which is safe to report precisely because the caller had to prove
the identity being counted first.

The `user_id` column on a session row scopes revocation and does nothing else. It is never a second
way to resolve an actor; see the third demo-safety rule below.

[`ADR-005`](../decisions/adr-005-durable-sessions-and-revocation.md) records why a server-side
record rather than short-lived tokens plus refresh, why legacy tokens are refused, why bearer
tokens inherit their parent's revocation, and the seam with issue #99.

Every identity state change is written to `identity_audit_events` in the same D1 batch as the
change itself, so an audit row cannot claim something that did not happen and a change cannot
happen unaudited. The table is append-only and carries no credential — no `id_token`, no
`code_verifier`, no `state_proof`, no session token, no cookie value. **The Google callback's
refusals are the one identity refusal that is not audited**, deliberately: they have no state
change to batch a row with, and a best-effort write would either turn a refused sign-in into a 500
or be dropped silently. They stay in the structured log as `auth.google.refused`, which is where an
operator investigating a failed sign-in should look.

## Three rules that keep the demo population and the real one apart

The deployed demo runs `DEMO_MODE=true` against one D1 database, and `GAP-019` records that the
same database would hold real self-serve organizations if Google were configured there. The
authorization model already isolates the two structurally — `findByPersona` pins
`id = 'seed-' + persona`, the two cookie grammars are mutually unparseable, and every event-owned
read goes through `requireEventCapability` against a grant on that exact event. Membership
administration is the first feature that can break that, because `seed/reset.sql` gives the seeded
personas real addresses (`organizer@greenroom.test` and the rest). These three rules exist so it
cannot, and each is proved by breaking the guard and watching a named test fail.

Rules 1 and 2 bind the membership administration this lane has yet to land; there is no route in
the repository that writes `organization_memberships` or `event_roles` today, and they are stated
here first so that the work is written against them rather than audited afterwards. Rule 3 is in
force now.

1. **An invitation is accepted by the accepting session's own identity, never by address lookup.**
   Acceptance requires `authentication === "session"` and grants membership to *that actor's* user
   id. Were acceptance a match against a stored address, a real organizer could invite
   `organizer@greenroom.test`, and pressing **Continue as organizer** on the demo landing page
   would afterwards open a real organization.
2. **A demo persona id is never a valid grant target.** The predicate is derived from the
   `personas` object's own keys in `application/identity/demo-session.ts`, so it cannot drift from
   the four seeded rows, and every membership, invitation and event-role write whose subject is
   one is refused. The seeded demo grants come from seed SQL, so refusing them at the route costs
   nothing and removes the crossing entirely. The refusal is audited.
3. **No code path resolves an actor from anything but `findByPersona` (demo) or `findByUserId`
   (real).** In particular the `user_id` column on a session record is used only to scope
   revocation and to be compared against the id the signed cookie already carries — it is never
   followed to produce an actor. A demo persona cookie takes no session lookup at all, which
   `identity-sessions-http.test.ts` asserts by counting the store's reads across a persona's whole
   request.

## Two credential grammars, one cookie name

A demo-mode deployment with Google configured holds two kinds of credential in `greenroom_session`
at once, and the middleware resolves both: the real user session first, the persona cookie second.
That order is safe because the two grammars are mutually unparseable rather than merely different.
A user session is `base64url(payload).signature` — exactly two dot-separated parts, and the
resolver refuses a third. A demo session is `persona.expiry.hexSignature` — exactly three parts,
and the resolver refuses anything whose first part is not one of the four known personas, whose
signature is not 64 hex characters, or whose expiry is not a safe integer. Neither can be read as
the other even though both are signed with `SESSION_SECRET`, so trying one and then the other
introduces no ambiguity about which credential the caller presented.

The `authentication` kind follows what actually resolved rather than what the deployment mode is, so
a real Google session on a demo deployment is reported as a `session` and a persona cookie as
`demo`. That is a description of the credential rather than a grant, and it is worth being exact
about the difference. Two routes read that value. `GET /api/session` reports it, so the console can
tell a persona it should offer to *switch* from a session it should offer to *sign out* of — the two
arrive in the same cookie and are otherwise indistinguishable to the client. `POST /api/auth/tokens` is
the only route that lets it decide anything, and it
answers 404 to every caller while `demoMode` is set, before it reads it. So event-scoped bearer
tokens remain a non-demo feature, and no demo configuration mints one. Nothing about the persona
path changes — `findByPersona` still pins
`id = seed-<persona>`, so a persona cookie resolves to one of four seeded rows and can never
resolve to a self-serve user. That is authorization isolation between the two populations, and it
is not deployment isolation: they share one database, and `GAP-019` records what the demo reset
does to the self-serve half of it.
