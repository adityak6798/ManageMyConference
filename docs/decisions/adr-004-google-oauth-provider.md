# ADR-004: Google OIDC as an additional sign-in provider

Status: accepted | Owner: identity-access | Date: 2026-08-12

## Context

`GAP-007` and issue #12 have owed an approved provider ADR since emailed-code sign-in landed with
issue #60. Production authentication today is a six-digit code mailed to an address and exchanged
for a signed, expiring HttpOnly cookie (`ARC-AUTH-001`, `PRD-IAM-001`). It works, and two of its
properties bound the product: it cannot issue a single session until a mail provider is configured
and reachable, and every first sign-in costs a round trip through somebody's inbox. Neither is a
defect; both are reasons to have a second door rather than only that one.

The gap the second door closes is not "a nicer login screen". It is that this product had no way
for a stranger to *become* a user: every identity in the system was seeded by a reset or created
by an operator, and the deployed demo admits nobody except its four personas. Self-serve signup —
a visitor arriving at `/`, signing in, and finding an organization and a first event waiting — is
what turns the demo from a tour into a product, and it needs an identity provider that already
knows who the visitor is and has already verified their address.

Google is that provider, on three grounds. Two are checkable: the OIDC profile of OAuth 2.0 is a
published standard rather than a vendor protocol, so the same code shape serves the next provider;
and the parts of it that matter here — `state`, PKCE, a signed `id_token` — are implementable
against Web Crypto with no dependency at all. The third is an assumption this record states rather
than proves — that most conference organizers already hold a Google account — and it is the one to
revisit if a second provider is ever asked for.

## Decision

**Google OIDC is an additional provider beside emailed codes, never a replacement.** A deployment
may configure both, either, or neither: `runtimeAuth` still refuses to boot a non-demo deployment
without `AUTH_EMAIL_ENDPOINT`/`AUTH_EMAIL_TOKEN`, and `GET /api/auth/config` reports each door
separately so the sign-in surface offers what this deployment can actually complete. A single
provider is a single point of failure for *access to your own data*, and an organizer locked out
by an outage at one identity vendor is locked out of an event they are running that week. The two
paths converge immediately: both mint the same signed session cookie for the same `users` row, so
everything downstream of authentication — memberships, event roles, capabilities, the
current-session query — is provider-blind.

**An account is linked on the provider's subject first, and only then on a verified address.**
`identity_provider_accounts` is keyed on `(provider, subject)`, because Google's `sub` is stable
across an address change and an address is not. When no such link exists, the *verified* address
from the `id_token` is matched against `identity_emails`, and a match links the provider account
to that existing identity rather than creating a second one — a seeded speaker who signs in with
Google is that speaker, with the speaker's access, not a new organizer holding an empty
organization beside their real one.

**An unverified address is refused outright.** `email_verified` false — or absent, or any value
other than the boolean `true` and the string `"true"` Google has historically sent — ends the
sign-in with the same indistinguishable failure every other refusal produces. This is the
load-bearing half of the linking rule, and it is worth stating as a threat rather than as a
validation: linking on an unverified address means anyone who can convince *any* provider to mint a
token asserting `victim@example.com` inherits that victim's memberships, event roles and
capabilities.
"I claim this address" is an account-takeover primitive, not an identity. Only "this provider
verified this address" is allowed to link.

**The profile comes from the verified `id_token` claims, not from a second userinfo call.** `sub`,
`email`, `email_verified` and `name` are read from the token *after* its RS256 signature verifies
against the key Google publishes for the `kid` in its header, and after issuer, audience, expiry
and per-attempt `nonce` all check out. A `GET` to the userinfo endpoint would return roughly the
same fields with none of that: nothing in that response is signed, so its whole integrity is that
it arrived over TLS from a host we chose, and it is one more round trip on every sign-in for the
privilege. Reading a claim from an unverified token
— even to decide which key to check it with — is how "validated" JWT handling usually fails, so
the one header field read before verification is `kid`, and a `kid` naming no published key is a
refusal rather than a fallback.

**The protocol is spoken with raw `fetch` rather than `google-auth-library`.** That package pulls
`node:fs` in through its credential chain, which a Worker resolves only with the `nodejs_compat`
compatibility flag — a runtime change affecting *every* route in this deployment, adopted from
inside one domain's change, to serve one adapter. This is the same reasoning the
[wave ledger](../exec-plans/competition-waves.md) records for `@anthropic-ai/sdk`, and it lands the
same way: the three delivery adapters and the suggestion adapter already speak raw `fetch`, the
adapters layer has an enforced external-package allowlist, and a stubbed `fetch` is how their
contract suites prove them. The protocol here is one POST and one GET. Revisit if the Worker ever
needs `nodejs_compat` for its own reasons; at that point the library becomes the cheaper option and
this paragraph is the record of why it was not taken first.

**The redirect URI is deployment configuration and never a request parameter.**
`GOOGLE_REDIRECT_URI` is a binding, validated at boot as an absolute http(s) URL, passed into the
authorization request and again into the token exchange. Nothing in a request decides where an
authorization code is delivered or where the browser goes afterwards; every post-callback
destination in the route module is a string literal. A redirect URI taken from a parameter is the
open redirect, and it is the one mistake in this flow that turns a login button into a credential
exfiltration endpoint. It is deliberately *not* derived from `PUBLIC_BASE_URL` either, because
local development inherits that value from the deployed demo. The three bindings are one unit: a
partial configuration refuses to boot by name rather than failing after the user has already been
sent to Google and back.

**Sign-out clears the cookie and is named for what it does.** `POST /api/auth/signout` deletes the
session cookie and answers 200 whether or not one was present. It is not revocation: the cookie is
a signed bearer with its own expiry and nothing server-side tracks it, so a copy taken elsewhere
survives. Durable revocation stays with issue #12, and naming this honestly is what keeps that
distinction visible instead of letting a logout button imply a guarantee.

## Consequences

A visitor can become a user without an operator, and a workspace exists for them when they arrive:
one organization named after them, one first event, the organizer role on it. Provisioning crosses
into the events domain as `EventService.provisionOrganization` plus the ordinary authorized
`create`, so identity never learns an events table and a first event is created exactly as every
later one is.

Sign-in is provider-blind downstream, so no authorization rule and no capability check needed
changing to accommodate Google. Adding a second provider later is a row in
`identity_provider_accounts` and one more adapter, not a change to how sessions work.

A deployment carrying no Google bindings behaves exactly as it did before: `google: false` in the
auth config, 404 from both Google routes, and a configuration object byte-for-byte the one it had.
That property is what lets this ship to a demo deployment that deliberately leaves Google
unconfigured — see `GAP-019`, which is about the demo reset deleting real self-serve rows, not
about anything in this decision.

The refusal surface is deliberately opaque. Every failure — unknown attempt, mismatched `state`,
expired attempt, unverified signature, unverified address — redirects to the same
`/signin?auth=failed`, with the reason in the Worker log. That costs a contributor debugging their
own Google configuration a log read instead of an on-screen message, and it is the right trade:
naming which check refused hands an attacker the oracle the flow exists to deny them.

What this does not buy: rotation and recovery operations, membership administration, audit events
and durable revocation all remain open under issue #12, and **Google sign-in has never exchanged a
request with Google from this repository.** No OAuth client exists here, so the token exchange and
the key fetch have never run against the real endpoints. What is proven is the protocol — the
verifier is driven against tokens signed by a real RSA key pair, with each guard written so that
removing it makes a forged token verify rather than fail differently — and the shape of the two
network calls is written from documentation. The same shape of gap as `GAP-011` and `GAP-012`, for
the same reason.

## Alternatives

**A NextAuth-style library (Auth.js, Lucia, or `google-auth-library` behind them).** Rejected on
the same grounds as the SDK above plus one more: these libraries own the session, the cookie and
the callback route, and this repository already has a signed-session model with an expiry, a
bearer-token variant, and demo personas resolving through the same cookie name. Adopting a
library's session model means either running two of them or migrating the existing one, and the
part it would have saved us — `state`, PKCE, JWT verification — is about 300 lines that we want to
read anyway because they are the security properties.

**Magic links only — extend the emailed-code path and stop there.** It is already built, and it
needs no provider. Rejected because it does not solve the problem this ADR exists for: it still
requires a configured mail provider before anybody can sign in, still costs an inbox round trip on
every first use, and gives us an address that *nobody has verified* except by demonstrating
control of the mailbox at that moment. For self-serve signup that is a slower, worse-verified
version of what the `id_token` already asserts.

**A hosted IdP (Auth0, Clerk, WorkOS, Cloudflare Access).** Rejected for a competition-scoped
project: it adds a paid third-party dependency in the authentication path, moves the user
directory outside the D1 database that `ADR-002` makes canonical, and requires a tenant nobody
evaluating this repository can provision. It also does not remove the work — provider linking, the
verified-address rule, and provisioning are all still ours — it only moves where the token comes
from.

## Supersession

Supersedes nothing. `ADR-001` (Cloudflare TypeScript) and `ADR-002` (canonical SQL) both stand
unchanged: this decision keeps the user directory in D1 and the runtime in the Worker. It will be
superseded when a second provider makes "Google" the wrong name for this record, or when durable
revocation under issue #12 changes what a session is — either of those is a new ADR rather than an
edit to this one.
