# Data flows

Status: canonical | Owner: architecture | IDs: `ARC-FLOW-001`–`ARC-FLOW-004` | Last verified: 2026-08-09

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
