# Authorization

Status: canonical | Owner: security | ID: `ARC-AUTH-001` | Last verified: 2026-08-14

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

## A submitter is authorized by ownership, not by a capability

A person proposing a talk holds no role on the conference — that is what a public call for
proposals means — so the CFP's account-bound routes are the one place in this API where an
authenticated caller is authorized by **owning the row** rather than by holding a capability on the
event. `requireEventCapability` would be the wrong instrument twice over: it refuses everybody who
has not been staffed, and the alternative — granting an event role to anyone who opens a form —
would hand a capability model's guarantees away to strangers.

**The first enforcement point is the credential's *kind*, and it is the transport's.** These routes
never consult an event grant, so an event-scoped bearer token's one restriction — the event it was
minted for — would go unread, and a token issued for one event would work against every other. An
API-client credential is worse: it satisfies "is there an actor" with no scopes at all, and its `id`
names a client row rather than a user. Both are refused with `403` by middleware on the
`/api/events/:eventId/cfp/proposals` prefix, so a route added under it later inherits the refusal
rather than quietly omitting it. A cookie session — real or demo — passes. This differs from
identity's own routes, which answer `401` and refuse demo sessions as well; the divergence is
deliberate, because here the caller is authenticated and it is the credential's kind that is wrong,
and because a demo persona is a legitimate submitter on a demo deployment.

The rest is narrower rather than weaker, and it is enforced in three further places.
`CfpService` requires a session at all (`submitterFor`); every read is scoped to
`(event_id, id, submitter_user_id)`; and every write puts that triple *and* the expected revision
*and* the open-window condition in its own `WHERE` clause, so a write naming another account's
proposal matches no row rather than being refused after a check. A proposal belonging to somebody
else answers exactly as one that does not exist — the same indistinguishability rule the rest of
this document states for cross-tenant lookups — so proposal ids cannot be enumerated from any
account. Migration `1201` adds the last place: a trigger refuses any `UPDATE` that changes
`submitter_user_id`, so no write path can move a proposal onto another dashboard or claim an
anonymous one. A caller-supplied idempotency key is namespaced by its owner before it is stored, so
the per-event uniqueness constraint behind duplicate suppression cannot make one account's key
resolve to another's proposal.

The submitter view is also *narrower than the organizer's data*: it reports `draft`,
`under consideration`, `accepted` or `not accepted` and never the configured triage status, because
an event may configure statuses that describe the inside of a review process.

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
writing its tables — idempotently per person per organization, so two concurrent first sign-ins
converge on one workspace rather than two (issue #164). **Completing a workspace provisions and
never adopts**, and only into an organization that holds no events and has no other member:
"an organization, and no event role" is also what an organization-level invitation leaves and what
revoking somebody's only event role leaves, and granting on an existing event there would hand a
member `agenda:manage`, `review:manage` and `events:settings:update` that nobody granted — or
silently reverse a revocation the audit log says succeeded. Every refusal in the flow — unknown attempt, wrong
`state`, expired, bad signature, unverified address — redirects to one destination and logs its
reason, so the callback is not an oracle. A failure that is *ours* rather than a refusal is the one
exception, and lands on `/signin?auth=unavailable`: an outage answers none of the checks a forged
callback could pose, and telling somebody their sign-in did not complete when the deployment broke
sends them to check an account that is fine.

The browser presents **every** attempt it has outstanding, not one (issue #166): two tabs are two
sign-ins in flight, and the `state` proof identifies which of them a callback belongs to. The
cookie is still the browser-binding half of the CSRF defence — a callback presented to a browser
holding none of those ids is refused before the provider is asked — and only the attempt a callback
actually spends is dropped from it. The redirect targets are string literals; nothing in the request decides where the
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

The deployed demo runs `DEMO_MODE=true` against one D1 database, and the same database holds real
self-serve organizations wherever Google is configured there — `GAP-019` records how the demo
restore now refuses rather than deleting them. The
authorization model already isolates the two structurally — `findByPersona` pins
`id = 'seed-' + persona`, the two cookie grammars are mutually unparseable, and every event-owned
read goes through `requireEventCapability` against a grant on that exact event. Membership
administration is the first feature that can break that, because `seed/reset.sql` gives the seeded
personas real addresses (`organizer@greenroom.test` and the rest). These three rules exist so it
cannot, and each is proved by breaking the guard and watching a named test fail.

All three are in force. Rules 1 and 2 govern membership administration, which is
`MembershipService` and the `/api/organizations/{organizationId}/…` routes; rule 3 governs session
issuance.

1. **An invitation is accepted by the accepting session's own identity, never by address lookup.**
   Acceptance requires `authentication === "session"` and grants membership to *that actor's* user
   id. Were acceptance a match against a stored address, a real organizer could invite
   `organizer@greenroom.test`, and pressing **Continue as organizer** on the demo landing page
   would afterwards open a real organization.
2. **A demo persona id is never a valid grant target — nor a valid administrator.**
   `isDemoPersonaId` is derived from the `personas` object's own keys in
   `application/identity/demo-session.ts`, so it cannot drift from the four seeded rows, and every
   membership, invitation and event-role write whose subject is one is refused. The seeded demo
   grants come from seed SQL, so refusing them costs nothing real and removes the crossing
   entirely. A persona is also refused as the *actor* of any membership write, which is wider than
   the crossing strictly requires and is the deliberate choice: a persona holds the seeded
   organizer's capabilities, so anything it wrote would be real state in the demo organization,
   handed to whoever presses **Continue as organizer** next. Both refusals are audited with
   `outcome = 'refused'`, which is the row an operator most wants to find. The cost is that the
   browser suite — which runs in demo mode and has only personas — cannot drive the
   invite-and-accept journey at all; that journey is proved against real D1 in
   `d1-identity-membership.integration.test.ts` and at the transport in `membership-http.test.ts`,
   and the browser asserts the refusal instead.
3. **A seeded persona id is never the subject of a real session, and a session record is never a
   route to an actor.** Four functions resolve an actor, and being exact about them matters more
   than a slogan: `findByPersona` for a demo persona cookie, `findByUserId` for a session or
   bearer token, and — on the sign-in paths only — `findByProviderAccount` and `findByEmail`,
   which are how account linking finds the identity that already holds a verified address. The
   last of those is what makes this rule necessary rather than obvious. `seed/reset.sql` gives
   the personas real addresses, so on a demo deployment with Google configured a real sign-in as
   `organizer@greenroom.test` *would* resolve to `seed-organizer`. Both issuing routes therefore
   refuse a subject for which `isDemoPersonaId` holds: the emailed-code route with the same 401 it
   gives an unknown address, and the Google callback with the same indistinguishable redirect it
   gives every other refusal. Separately, the `user_id` column on a session record is used only to
   scope revocation and to be compared against the id the signed cookie already carries; it is
   never followed to produce an actor. A demo persona cookie takes no session lookup at all, which
   `identity-sessions-http.test.ts` asserts by counting the store's reads across a persona's whole
   request.

## Membership administration is authorized at the organization

`identity:manage` is an event-earned capability like every other, granted by the organizer role,
and it is deliberately not a global administrator. An organization-addressed route takes three
conditions together — the capability, membership of the named organization, **and** that the
capability was earned on an event belonging to that organization — which is the pattern the CRM
directory already uses and which `MembershipService.requireOrganization` implements. The third
condition is the one that is easy to leave out: the first two can be satisfied by two *different*
organizations at once, so somebody who organizes an event in A and merely belongs to B would
otherwise administer B on the strength of a grant A gave them.

What this bounds is the **organization**, and that is wider than `requireEventCapability` — an
organizer of one of its events can administer the whole of it, including staffing themselves on an
event they hold no grant on. That is intended: the organization is the tenant boundary and its
organizers are its administrators. It is stated because it is not what an event-scoped capability
would give, and somebody reading only the capability name would assume otherwise.

An event role is addressed under the organization that owns the event —
`/api/organizations/{organizationId}/events/{eventId}/roles/{userId}` — rather than under the event
alone, because the address is where the authorization happens: the organization in the path is what
`requireOrganization` runs against, and the event is then checked to belong to it.

Removing a membership or an event role takes effect on the **next request**, without touching any
session record, because `resolveUserSession` re-derives the actor from D1 every time. That is why
removal does not revoke sessions: the person may hold memberships elsewhere that are none of this
organization's business. `d1-identity-membership.integration.test.ts` proves it by removing a role
and resolving the actor again.

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
about the difference. Three routes read that value, and two of them let it decide something.
`GET /api/session` only reports it, so the console can tell a persona it should offer to *switch*
from a session it should offer to *sign out* of — the two arrive in the same cookie and are
otherwise indistinguishable to the client. `POST /api/auth/tokens` refuses every caller while
`demoMode` is set, with a 404, *before* it reads the value at all; so event-scoped bearer tokens
remain a non-demo feature and no demo configuration mints one. `POST /api/auth/sessions/revoke-all`
is the one that genuinely rests on it: it does **not** 404 on a demo deployment where Google is
configured, because that deployment really can hold revocable sessions, so the
`authentication !== "session"` test is the whole of what keeps a persona out. A persona resolves
as `demo` and gets 401 having cost the session store no read, which
`identity-sessions-http.test.ts` asserts directly. Nothing about the persona
path changes — `findByPersona` still pins
`id = seed-<persona>`, so a persona cookie resolves to one of four seeded rows and can never
resolve to a self-serve user. That is authorization isolation between the two populations, and it
is not deployment isolation: they share one database. What the demo reset does to the self-serve
half of it is `GAP-019`, now closed — the restore counts the rows the seed did not create and
refuses rather than deleting them — and one database still holding both populations is what that
entry records as unfixed.

## A custom role is a fifth grant, and its field policy is resolved with it

The four roles above are the built-ins. An organizer may also compose **custom roles** on one
event — an AV operator, a programme assistant, a sponsor liaison — and `event_roles` admits a
fifth value, `custom`, paired with the role it names. The pairing is a database constraint rather
than a convention: `CHECK ((role = 'custom') = (custom_role_id IS NOT NULL))`, so neither half can
exist without the other. The primary key is unchanged, which states the rule plainly — a person
holds at most one custom role on an event.

A custom role carries two sets. Its **capabilities** are drawn from a fixed allowlist that
deliberately excludes `identity:manage`, enforced by a CHECK on the table rather than by the
service alone, because a role that could grant capabilities could grant itself the ones withheld
from it. Its **field policies** decide, per record kind and per field, whether the holder may
View, Lock (read, not write) or Hide (not receive at all) — with `*` as the subject-wide default,
and a required field's Hide clamped to Lock, since a record with no identifying field is
unjoinable to whoever is reading it.

**Field access is resolved in the same D1 read that resolves roles.** `resolve()` joins the custom
role, unions its capabilities and its field policies, and hands `FieldAccess` back on the actor.
That is the whole reason a screen, a CSV, an XLSX, a JSON report and an expiring share link cannot
reach different answers: there is one decision, made at the application boundary, and every reader
is downstream of it. A field the client hides and the API returns is not hidden. Composition
across several grants is least-restrictive, matching how capabilities already union, and the
*absence* of a field-policy set on a built-in grant means unrestricted rather than hidden.

Hidden fields are **absent from the payload rather than blanked**. The contracts mark them
optional and the redaction returns `Omit<T, K> & Partial<Pick<T, K>>`, so a consumer that forgot to
handle a hidden field fails to compile instead of printing an empty cell that reads as "no phone
number on file". Redaction happens at the read boundary only: internal write paths load the
unredacted record, because a service that cannot see a field it is about to write is a different
and much worse bug.

Previewing a role resolves the **stored role** and never fetches anything on its behalf. A preview
that ran a real read "as" the role would run under the administrator's own grants and show their
data wearing the role's name.

`event_field_locks` is deliberately a *different* table with the same vocabulary. A role policy
governs somebody staffed onto the event; a lock governs the person whose record it is, on their
own portal, and is merged onto every **non-organizer** grant at the stricter of the two. A speaker
holds no custom role, so nothing in the roles model could ever have closed their own portal — which
is why that write surface used to be fixed in code. Locks are replaced as a whole set, so what is
stored is what the organizer confirmed.

`reports:pii` is the capability that unmasks personal columns in a report. It is held by neither
role by default, must be **requested explicitly on the run** as well as held, and exercising it is
recorded. Holding a capability and using it are different facts, and only one of them is worth an
audit row.

## A capability link is an anonymous grant with a stated shape

Some things are shared with somebody who has no account: a report answer, an attendee's itinerary,
and — when `GAP-028` is picked up — a speaker profile or asset. `capability_links` is the one
convention for all of them, so a second one does not get invented per feature.

A link is minted as an opaque token, and **only its hash is stored**, so the table is not a list of
live credentials. It addresses `(resource_kind, resource_ref)` with no foreign key, because the
resources it points at are owned by other domains; `report`, `speaker-profile` and `speaker-asset`
are all declared today, and the last two are resolved by nothing yet, on purpose. A link may carry
a password (hashed), an expiry no further out than 30 days, and a view limit; spending one checks
every constraint in one place and records the view. Revocation is immediate and is a column rather
than a delete, so a revoked link stays auditable.

This is the shape `DEBT-012` records for capability URLs, and it is now a primitive rather than a
pattern each feature copies.
