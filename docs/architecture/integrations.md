# Integration architecture

Status: canonical | Owner: platform | IDs: `PORT-EMAIL`, `PORT-CALENDAR`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS`, `PORT-AI` | Last verified: 2026-08-09

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
has not run. **No AI port exists at all**: the bullet below is a design constraint on future work,
not a description of code (`GAP-011`, issue #57).

- Email: enqueue template/version plus recipient reference; the delivery carries the message rendered from that template version, and the adapter reports the provider's message reference and a normalized result. *Live adapter implemented and contract-tested against a stub; unverified against a real mail API. Lifecycle events enqueue: acceptance, task assignment, reviewer assignment, an accept/decline decision, and — through the schedule-published event below — a per-speaker schedule confirmation. An organizer can also send from the console.*
- Calendar: generate deterministic ICS from scheduled canonical content; native Google/Microsoft OAuth is out of scope. *Implemented as a download; nothing delivers an invite to a speaker's calendar (issue #56).*
- Airtable/Accelevents: outbound, versioned, idempotent projections. SQL remains canonical. *Projection state and versioning are implemented; live adapters exist and upsert on the Greenroom reference, but no organizer-facing mapping, dry-run or connection-test workflow does (issue #23's Airtable product surface, issue #58).*
- AI: suggestion/draft only, with provenance, explicit acceptance, timeouts, and deterministic manual fallback. *Not implemented.*

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
