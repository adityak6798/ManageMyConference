# Data flows

Status: canonical | Owner: architecture | IDs: `ARC-FLOW-001`–`ARC-FLOW-005` | Last verified: 2026-08-12

## Proposal to publication (`ARC-FLOW-001`)

CFP form → validated submission → reviewer assignment → evaluation outcome → acceptance command → content and linked speaker → agenda placement → published projections. Each transition is audited and idempotent.

## Speaker work (`ARC-FLOW-002`)

Organizer task request → communication outbox → delivery attempt → speaker portal completion/upload → canonical content record → organizer-visible completion. R2 objects are private; authorized APIs issue access and public publication creates a separate safe reference.

## CRM conversion (`ARC-FLOW-003`)

Prospect/contact/activity → conversion command → content-owned speaker identity → CRM conversion link. Notes and outreach history remain CRM-owned and are not copied into public profiles.

## External projection (`ARC-FLOW-004`)

Canonical change → transactional outbox → versioned projection mapper → fake/live adapter → success or retryable/terminal failure → audit state. Provider data never overwrites SQL implicitly.

Every flow carries organization/event scope, actor, timestamp, correlation ID, and idempotency key where commands can repeat.

## Identity and event shell (`ARC-FLOW-005`)

Signed session → seeded identity → organization memberships/event roles → current-session capabilities → tenant-scoped event list → active event selection → role-aware navigation. Event creation carries an explicit organization ID and verifies membership before persistence. Object queries apply the actor scope before returning either data or the non-enumerating not-found response.

A session now has two ways to begin, and the chain above is what both of them join. Google sign-in
adds: authorize (attempt minted, `state` proof and PKCE verifier stored, browser redirected to
Google) → callback (attempt spent single-use, code exchanged, `id_token` verified before any claim
is read) → provider link (matched on `(provider, subject)`, else on the verified address, else a
new identity — an unverified address ends the chain here) → provisioning, for a new identity only
(organization, first event, organizer role, through the events domain's public service) → signed
session cookie → the same current-session capabilities every other actor resolves. Sign-out is the
chain's other end and stops at the browser: the cookie is cleared, and nothing server-side is
written, because nothing server-side was recorded when it was issued.

Provisioning is the one part of this that is not one transaction, because it crosses a domain: the
organization row is written first and is inert if nothing follows it, the identity batch (user,
address, provider link, membership) commits together or not at all, and the first event is created
last. A failure after the identity batch leaves an organizer with no event, which the next sign-in
completes rather than duplicating.
