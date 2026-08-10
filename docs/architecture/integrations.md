# Integration architecture

Status: canonical | Owner: platform | IDs: `PORT-EMAIL`, `PORT-CALENDAR`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS`, `PORT-AI` | Last verified: 2026-08-09

Application services call typed provider-neutral ports. Each port has a deterministic fake and contract suite; live implementations are credential-gated and cannot be required for pull-request CI.

- Email: enqueue template/version plus recipient reference; adapter reports provider message reference and normalized result.
- Calendar: generate deterministic ICS from scheduled canonical content; native Google/Microsoft OAuth is out of scope.
- Airtable/Accelevents: outbound, versioned, idempotent projections. SQL remains canonical.
- AI: suggestion/draft only, with provenance, explicit acceptance, timeouts, and deterministic manual fallback.

Provider calls originate from outbox workers, not open database transactions. Adapters normalize retryable versus terminal errors and never leak SDK types inward.

## Delivery lifecycle and recovery

`communications-integrations` owns immutable template versions, idempotently enqueued deliveries, immutable attempts, and outbound projection state. A trigger supplies organization/event scope, a stable idempotency key, a typed trigger, a recipient/resource reference, and a snapshot payload. Email triggers resolve and retain the exact template version; projection triggers retain their monotonically versioned payload. Reusing an organization-scoped idempotency key returns the original delivery.

Workers durably lease eligible `queued` or `retrying` rows before making a provider call. They then append an attempt and transition the delivery in one atomic storage batch. Retryable failures use bounded exponential backoff; malformed responses and provider rejections are terminal. A successful Airtable or Accelevents attempt updates idempotent projection state without making provider data canonical.

The organizer recovery procedure is:

1. Inspect `GET /api/communications/history?organizationId={organizationId}&eventId={eventId}` and its ordered attempt history.
2. Correct the referenced template, recipient, credential, or canonical source data as indicated by the normalized error code.
3. Submit `POST /api/communications/deliveries/{deliveryId}/retry` with the owning `organizationId`.
4. Reinspect history until a new immutable attempt is `succeeded` or yields a new actionable failure.

The retry action never deletes or rewrites prior attempts. Only an organizer in the owning organization has `communications:manage`; denial occurs before request-body parsing.
