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

Sign-out is `POST /api/auth/signout`, and it clears the session cookie. It answers 200 whether or
not a session was present, so it does not report whether the caller had one. It is deliberately not
revocation: the cookie is a signed bearer carrying its own expiry and nothing server-side tracks
it, so a copy taken elsewhere — or an event bearer token already minted from that session —
survives until it expires on its own. Durable revocation is issue #12 and `GAP-007`.

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
about the difference: `/api/auth/tokens` is the only reader of that value in the repository, and it
answers 404 to every caller while `demoMode` is set, before it reads it. So event-scoped bearer
tokens remain a non-demo feature, and no demo configuration mints one. Nothing about the persona
path changes — `findByPersona` still pins
`id = seed-<persona>`, so a persona cookie resolves to one of four seeded rows and can never
resolve to a self-serve user. That is authorization isolation between the two populations, and it
is not deployment isolation: they share one database, and `GAP-019` records what the demo reset
does to the self-serve half of it.
