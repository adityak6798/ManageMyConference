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
has not run. **No AI port exists at all**: the bullet below is a design constraint on future work,
not a description of code (`GAP-011`, issue #57).

- Email: enqueue template/version plus recipient reference; the delivery carries the message rendered from that template version, and the adapter reports the provider's message reference and a normalized result. *Live adapter implemented and contract-tested against a stub; unverified against a real mail API. No lifecycle event enqueues a delivery yet (`GAP-010`, issue #66) — an organizer sends from the console.*
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

**This is not fixed by a conditional write, because the providers do not offer one.** Airtable's
REST API has no precondition on a record write: no `If-Match`, no ETag, no compare-and-set, and
`performUpsert` matches on a field value rather than on a version. There is no request we could
send that the server would refuse on version grounds, so "only apply if you still hold v1" is not
expressible. The same is true of the Accelevents contract as documented. A precondition is the
right fix and it is unavailable, which is why what follows is a repair rather than a prevention.

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
