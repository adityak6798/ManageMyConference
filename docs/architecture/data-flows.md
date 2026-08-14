# Data flows

Status: canonical | Owner: architecture | IDs: `ARC-FLOW-001`–`ARC-FLOW-006` | Last verified: 2026-08-14

## Proposal to publication (`ARC-FLOW-001`)

CFP form → validated submission → reviewer assignment → evaluation outcome → acceptance command → content and linked speaker → agenda placement → published projections. Each transition is audited and idempotent.

**There are two entrances, and only one of them produces an owner.** An anonymous submission
(`POST /api/public/events/:eventId/submissions`) records no `submitter_user_id`, so it reaches no
dashboard, cannot be edited, and cannot be claimed later. An account-bound proposal is written
through `/api/events/:eventId/cfp/proposals`, where the owner is the resolved session and is
immutable, and it may exist as a *draft* first — which is not a submission and is invisible to every
reader downstream of this flow until it is submitted.

**Where a message's recipient comes from decides whether it can be sent at all.** A submission
confirmation is addressed by resolving the submitting session's user id through identity's directory;
nothing the request carries reaches the recipient field. That is the whole difference between this
message and the one decision `D5` refused to ship, and it is why `#132` narrows here: the
unauthenticated form can still be filled in with somebody else's address, but no send is directed by
it, and a decision is now readable on the submitter's own dashboard without any mail at all. A
decision notification follows the same preference through one rule stated in the communications
domain, `lifecycleRecipient`: the address identity holds for the owning account wins whenever there
is one, and the form-supplied address is the fallback. Review reports both `submitterUserId` and
`submitterEmail` and resolves neither — an address is identity's to answer for — so the composition
root, where a lifecycle fact meets identity's answer about the same person, is where the choice is
made. A *guest* proposal has no account, so its decision still addresses the form-supplied address
and still carries only the fact of a decision (`D6`).

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
address, provider link, membership) commits together or not at all, and the first event and the
organizer role on it commit together last, in one batch. A failure after the identity batch leaves
an organizer with no event, which the next sign-in completes rather than duplicating.

**Two of these at once is ordinary** — one person with two tabs open — and neither of the two marks
that would leave behind is repairable by the product, since nothing deletes an event and nothing
deletes an organization. So each is prevented by storage rather than by ordering (issue #164): the
identity batch's own uniqueness picks one winner and the loser signs in as it, and the events
domain's provisioning key, unique per person per organization, makes the second first-event writer
adopt the first's event. Provisioning happens only into an organization with no events and no
other member, so the same code path never completes somebody else's workspace. The organization the losing callback created is discarded by that callback, which
also keeps the deployment's demo restore able to tell real rows from seeded ones (`GAP-019`).

## Event configuration reuse (`ARC-FLOW-006`)

Source event → each domain's slice exports its own configuration → one immutable template version
(opaque JSON per slice, held by `events`) → organizer confirms a destination event and its date
range → preview, which writes nothing → per-slice apply against the destination → one recorded
application row binding that event to that version.

The shape of this flow is set by three facts about this repository, and each of them is load-bearing.

**Events does not import six domains.** It declares `EventConfigurationSlice` in
`apps/api/src/application/events/template-ports.ts`; each domain implements its own slice inside its
own application directory and exports it from that domain's `public.ts`; `apps/api/src/index.ts`,
the declared composition root, constructs them and hands the array to `EventTemplateService`. Events
therefore depends on nothing but its own port type, holds every payload as opaque JSON, and no
architecture allowlist entry exists for any of it. The precedents are `OutreachDispatchPort`, which
keeps CRM from importing communications, and `PreparedDeliveryWriter`.

**Creating and configuring are two requests, deliberately.** The request actor is a frozen snapshot
resolved once in middleware before any handler runs. `EventService.create` grants the caller the
organizer role, that row lands in D1, and the in-flight actor object is not updated — so a single
request that created a destination event and then configured it would be denied by every
`requireEventCapability` on the event it had just made. `POST /api/events` creates; the client
re-reads its session; `POST /api/events/:eventId/template-applications` applies. Nothing anywhere
synthesises an actor to get around this, for the reason
`apps/api/src/application/communications/public.ts` states at length: a fabricated actor is an
authorization check that has stopped meaning anything.

**There is no cross-domain transaction, and none is claimed.** `D1DatabasePort.batch` is per-adapter
and each domain's repository owns its own writes, so "atomic across seven domains" is not achievable
without inventing a mechanism, and inventing one is not this flow. What ships instead is the issue's
own second option: a documented, repairable per-domain result that hides no partial state. Every
slice reports exactly one of `applied`, `skipped`, `incompatible`, `unauthorized` or `failed` with a
reason an organizer can act on; a `failed` slice does **not** roll back the slices that already
succeeded; and the overall result says `partial` when that happens rather than `applied`. The repair
is to apply again, which is safe because every slice is idempotent on a natural key — `event_id` is
the primary key of `cfp_forms` and `review_plans`, `(event_id, key)` of `cfp_statuses`, one row per
event in `agenda_drafts` and `public_event_projections`, and `(event_id, slug)` for speaker
resources and `(event_id, title)` for speaker task templates, both upserted rather than inserted.

Convergence needs one thing beyond a natural key, and it is easy to miss: **every slice compares
before it writes.** Each of these commands stamps something on every call — an optimistic-concurrency
version, an `updated_at`, a draft revision — so a second application of an unchanged template would
rewrite the destination and change its bytes for no change in its configuration. Each slice
therefore reads the destination, compares it against the payload, and returns `applied` with
"nothing needed to be written" rather than calling the command at all. That is what makes
"apply twice, then compare" a real assertion instead of one that has to make an exception for a
counter, and it is asserted per slice with a spy on the storage seam.

Dates are a parameter of the clone rather than a property of an event, because an event carries no
start or end date in this system: the only event range is `startsOn`/`endsOn` inside publishing's
`public_event_projections.draft_json`, where `resolveEventDates` falls back to agenda-derived days.
The organizer confirms a destination range on every application, and a slice holding absolute
instants derives its own offset against it in the destination event's IANA timezone. Adding date
columns to `events` would change publishing's date-resolution rule and belongs to its own issue.
