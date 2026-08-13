# Integration architecture

Status: canonical | Owner: platform | IDs: `PORT-EMAIL`, `PORT-CALENDAR`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS`, `PORT-AI` | Last verified: 2026-08-12

Application services call typed provider-neutral ports. Live implementations are credential-gated and cannot be required for pull-request CI.

What exists today: an HTTP adapter exists for each of the three delivery channels — `email`,
`airtable` and `accelevents` — alongside the deterministic fake, and
`apps/api/src/adapters/providers/configuration.ts` chooses between them from
`COMMUNICATIONS_PROVIDERS`. `fixture` is the default and is what local development, CI, Playwright
and the demo run on; `live` requires every credential and throws rather than falling back to a
fake. That throw happens in the scheduled drain, not at startup, so a misconfigured deployment
serves requests normally and simply never sends — deliveries accumulate as `queued`. **No live adapter has ever exchanged a request with its real API** —
no credential for any of the three exists here — so the request shapes are written from
documentation and covered by a stubbed contract suite, and the staging smoke in
[communications providers](../engineering/communications-providers.md#staging-smoke--required-and-not-yet-performed)
has not run. The AI suggestion port now exists on the same terms: a deterministic fake as the
default, a credential-gated live adapter that has never met the real API, and — unique to this
port — a draft-only guarantee enforced in storage rather than by convention (issue #110).

- Email: enqueue template/version plus recipient reference; the delivery carries the message rendered from that template version, and the adapter reports the provider's message reference and a normalized result. *Live adapter implemented and contract-tested against a stub; unverified against a real mail API. Lifecycle events enqueue: acceptance, task assignment, reviewer assignment, an accept/decline decision, and — through the schedule-published event below — a per-speaker schedule confirmation. An organizer can also send from the console.*
- Calendar: generate deterministic ICS from scheduled canonical content. **Calendar-API integration** — writing into a speaker's Google or Microsoft calendar through those vendors' calendar APIs, with the OAuth grant and refresh-token custody that requires — is out of scope; iCalendar files and iTIP invitations are how a session reaches a calendar here. This says nothing about sign-in: Google OIDC *authentication* is implemented and is `ADR-004`, and it deliberately requests `openid email profile` and no Google API scope at all, precisely so that signing in never becomes a grant on somebody's calendar. *Two artefacts now, and they are not variations of each other. The download (`GET /api/events/{id}/speaker-calendar.ics`) is an import feed of one speaker's scheduled sessions, unchanged. The invitation (`buildSpeakerInvite`) is one session addressed to one person, carrying `METHOD:REQUEST`, an `ORGANIZER` and an `ATTENDEE`, which is what makes a mail client render Accept/Decline and write to the recipient's own calendar; `POST /api/events/{id}/speaker-calendar-invites` sends one per speaker per session through the outbox, and the speaker portal additionally offers Google and Outlook template links per session. Both share a UID, so a speaker who imported the file and is then invited ends with one entry, not two. Communications stores the last schedule and recipient enqueued for each session/speaker pair and advances that state atomically with the delivery. An unchanged press returns the existing delivery; a changed schedule or address gets the next monotonic `SEQUENCE`, even when a session returns to a time sent earlier, so out-of-order arrival cannot move the client backwards. The schedule confirmation the fan-out above sends still carries the download's URL rather than the invitation; wiring it to `buildSpeakerInvite` is one call and one payload key (issue #66). **Nothing here has been verified against a real mail client** — the fixture provider sends no mail, so what the suite proves is that the invitation is built correctly and reaches the provider (issue #56).*
- Airtable/Accelevents: outbound, versioned, idempotent projections. SQL remains canonical. *Projection state and versioning are implemented; live adapters exist and upsert on the Greenroom reference. Airtable still has no organizer-facing mapping, dry-run or connection-test workflow (issue #23's Airtable product surface).*
- Accelevents, inbound: registrations read into Greenroom as speaker profiles. *Implemented, with an organizer surface — preview, apply, last-run state and its failure — and a deterministic in-repository roster as the default source, so the demo and a fresh clone sync with no credential (issue #58). This is a different integration from the `accelevents` delivery channel above and runs the other way; both are one-way. The sync writes through content's public import command and touches no content table, which is what gives it a preview that writes nothing and convergence on re-apply for free. Its client has never exchanged a request with a real Accelevents tenant.*
- AI: suggestion/draft only, with provenance, explicit acceptance, timeouts, and deterministic manual fallback. *Implemented (issue #110). `REVIEW_AI_PROVIDER` selects `fixture` (the default, credential-free and deterministic), `live` (Anthropic, requiring `REVIEW_AI_API_KEY`) or `off`, and a half-configured `live` refuses rather than falling back — the same rule as the delivery channels, with one difference in where the refusal lands: it is caught in the composition root so a misconfigured assistant fails only the Draft button rather than the reviewer's queue. **Draft-only is structural, not conventional**: suggestions live in `review_suggestions`, which no aggregate query joins; accepting one writes the reviewer's evaluation as a draft and completing it is a separate act; `1310`'s `CHECK` refuses a suggestion that changes state without a named responder, and its trigger refuses an evaluation claiming provenance that is not its own. Provenance — model, prompt version, time, abstract revision — is stored per suggestion and rendered beside the draft. The abstract crosses the port **masked**, so blind review holds against a live model by construction. A slow, throttled or misconfigured provider normalizes to one of nine codes, surfaces as `502 UPSTREAM_UNAVAILABLE`, and leaves the manual scoring path untouched — asserted at service, route and rendered-card level. **The live adapter has never exchanged a request with the Anthropic API**: no credential exists here, the contract suite stubs `fetch`, and the staging smoke in [review suggestions](../engineering/review-suggestions.md#staging-smoke--required-and-not-yet-performed) has not run.*

Adapters normalize every HTTP result through one table of codes — retryable for throttling,
timeouts and outages; terminal for refusals, unparsable successes and unaddressable recipients —
so `error_code` in the delivery history means the same thing whichever provider produced it. No
provider response body ever reaches a stored code. The adapter codes, the credential model and
the rotation procedure are in
[communications providers](../engineering/communications-providers.md); the outbox itself adds
two of its own, `PROJECTION_SUPERSEDED` and `UNEXPECTED_PROVIDER_ERROR`, which are described
under [delivery lifecycle and recovery](#delivery-lifecycle-and-recovery) below.

Provider calls originate from outbox workers, not open database transactions. Adapters normalize retryable versus terminal errors and never leak SDK types inward.

## Domain events on the `event` channel

One channel calls nothing outside. An `event` delivery carries a domain event another domain
committed — today only `EVT-SCHEDULE-PUBLISHED` — so that the announcement of a fact and the fact
itself share one transaction. The agenda appends the record to the same D1 `batch` as its
publication through an opaque writer, so a crash between the two cannot leave a published
schedule nobody is told about, or an announcement of a snapshot that does not exist.

Draining it does not call a provider. It hands the record to a `DomainEventConsumer`, which
returns the same normalized result a provider does, so retry, backoff, immutable attempts and the
terminal state after three tries all apply unchanged. `SchedulePublishedConsumer` turns one such
record into one email per reachable speaker, keyed `schedule:{eventId}:v{version}:{userId}` — the
outbox is at-least-once, so a lease that expires mid-fan-out simply re-runs and nobody is written
to twice. An `event` delivery reaching a worker with no consumer bound fails terminally with
`NO_EVENT_CONSUMER` rather than sitting queued or reporting success.

The alternative this replaces was to model the publication as an `airtable` delivery, which would
have queued a fabricated push to somebody's base and written projection state claiming the
schedule had been sent there.

## Time-based reminders

The same one-minute tick that drains the outbox first asks content for open speaker tasks falling
due within the reminder window, and queues one reminder each. There is no bookkeeping table and no
"last reminded at" column: the key `task-reminder:{taskId}:d{offsetDays}` *is* the record, so the
next tick prepares the same key, the organization-scoped unique index returns the first delivery,
and nothing is written or sent. Anything less than that would mail a speaker every sixty seconds
the first time a crash landed between deciding to remind and recording it.

Overdue tasks are included rather than filtered out — a task whose window passed while nothing was
running is exactly the one worth a reminder — and each task is reminded about once. An escalating
series is not implemented: each step would need its own key and somebody has to decide when
nagging stops.

A tick is bounded, so the first run after this shipped works through a backlog over several ticks,
oldest first, instead of one invocation exhausting its subrequest budget and retrying the same
doomed batch every minute. One task whose reminder cannot be built is reported and skipped rather
than thrown, because this runs beside the drain and a broken template must not stall every queued
delivery.

## Delivery lifecycle and recovery

`communications-integrations` owns immutable template versions, idempotently enqueued deliveries, immutable attempts, and outbound projection state. A trigger supplies organization/event scope, a stable idempotency key, a typed trigger, a recipient/resource reference, and a snapshot payload. Email triggers resolve and retain the exact template version; projection triggers retain their monotonically versioned payload. Reusing an organization-scoped idempotency key returns the original delivery.

Workers durably lease eligible `queued` or `retrying` rows before making a provider call. They then append an attempt and transition the delivery in one atomic storage batch. Retryable failures use bounded exponential backoff and become terminal on the third attempt; malformed responses and provider rejections are immediately terminal. Manual recovery can explicitly request one further attempt while retaining the complete sequence. A projection is marked `PROJECTION_SUPERSEDED` without calling its provider when a newer version for the same destination/event/resource has already been requested. A successful Airtable or Accelevents attempt updates idempotent projection state without making provider data canonical.

The deployed Worker invokes the outbox from a one-minute scheduled trigger, drains at most 100 eligible deliveries per invocation, and reclaims a lease after five minutes when a prior invocation terminates unexpectedly. Provider exceptions are normalized into retryable attempts. Manual recovery cannot clear an active lease.

The organizer recovery procedure is:

1. Inspect `GET /api/communications/history?organizationId={organizationId}&eventId={eventId}&limit={limit}` and its ordered attempt history. Follow `nextCursor` for additional bounded pages.
2. Correct the referenced template, recipient, credential, or canonical source data as indicated by the normalized error code.
3. Submit `POST /api/communications/deliveries/{deliveryId}/retry?organizationId={organizationId}`.
4. Reinspect history until a new immutable attempt is `succeeded` or yields a new actionable failure.

The retry action never deletes or rewrites prior attempts. Only an organizer in the owning organization has `communications:manage`; denial occurs before request-body parsing.

## A late projection can leave the external system stale

`PROJECTION_SUPERSEDED` is checked before the provider call, so it cannot see a newer version
requested *during* one. Two projections for the same destination/event/resource can therefore
both be sent, and nothing orders their arrival: v1's HTTP call, issued first, can land after
v2's. When it does, the external system keeps v1's data while `outbound_projection_state`
correctly records v2 — the version guard on that row (`excluded.version >= …`) refuses the older
write. Both deliveries look like successes afterwards. Nothing in the history says the external
system disagrees with us, and nothing ever asks it.

**A conditional write would prevent this, and the providers do not offer one.** Airtable's REST
API has no precondition on a record write: no `If-Match`, no ETag, no compare-and-set, and
`performUpsert` matches on a field value rather than on a version. There is no request we could
send that the server would refuse on version grounds, so "only apply if you still hold v1" is not
expressible. The same is true of the Accelevents contract as documented.

That is why what follows is a repair rather than a prevention — but it is worth being precise that
a *provider* precondition is not the only prevention imaginable. Serializing the drain per
destination/event/resource, so two projections for one resource can never be in flight together,
would close the race inside this system using the lease mechanism that already exists. It is not
done here: the lease is per delivery, and making it per resource changes the outbox's concurrency
model for every channel to fix one channel's race. Recorded as the alternative rather than left
implied, because "the provider makes it impossible" is true of the conditional write and not of
the problem.

**What the code does instead is detect and repair.** The refusal above is observable — the upsert
updates no row — so `complete` reports it, and in the same durable batch re-queues the delivery
that owns the recorded version. That delivery re-sends the winning payload, and because every
projection adapter upserts on the resource reference, the external system converges rather than
duplicating. It terminates: the re-send records a version equal to the recorded one, which the
guard accepts, so no further repair is queued. The repair is in the batch rather than in the
worker because the refusal is observable exactly once — a worker that noticed it and then failed
would leave a stale external record that nothing could detect again.

**The window is bounded, not eliminated.** Between the stale write landing and the repair
draining, the external system genuinely holds older data — at most one outbox tick plus the
queue ahead of it, and longer if the repair's own attempts fail. A consumer reading Airtable in
that window reads stale rows. Anything that needs a strict guarantee must read SQL, which is
canonical by design (`PRD-INT-001`); the projection is a view and is eventually consistent with
a bounded, now self-correcting, lag.

The repair is visible: `delivery.attempt` carries `staleProjectionRepaired`, the re-send is an
ordinary second attempt on the winning delivery rather than a rewritten first one, and a rising
rate of it means projections are being enqueued faster than the outbox drains them. One case is
deliberately left alone — if the winning delivery has since been manually retried into
`terminal`, the repair does not resurrect it, because re-sending something an operator has
watched fail would fight the operator rather than help them.

**Two limits on what that flag can tell you**, both worth knowing before it is used as an alarm.
It is derived from *database commit* order, not from provider-landing order, and those can differ
in either direction. So it over-reports: v1's request can be processed by the provider first —
leaving the external system correctly on v2 — while v1's slower round trip makes its `complete`
land second, which refuses its projection write and queues a re-send that was not needed. The
re-send is harmless, because the adapters upsert. It also under-reports: if the late call's
`complete` happens to commit first, both writes are accepted, the flag is false for both, and the
identical staleness is invisible. Read it as "this delivery's projection write lost", which is
what it observes; staleness is the case it covers, not the case it proves.
