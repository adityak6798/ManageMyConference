# Communications providers: configuration and operations

Status: canonical | Owner: communications-integrations | IDs: `PORT-EMAIL`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS` | Last verified: 2026-08-12

How outbound deliveries actually leave the Worker: which provider is selected, what has to be
configured, what an operator does when one fails, and — stated plainly below — what has not been
verified against a live API.

## The two modes

`COMMUNICATIONS_PROVIDERS` selects the provider set at startup, in
`apps/api/src/adapters/providers/configuration.ts`.

| Mode | Providers | Needs credentials | Used by |
|---|---|---|---|
| `fixture` (default) | `DeterministicProvider` on all three channels | no | local development, `npm run check`, Playwright, the demo reset |
| `live` | `HttpEmailProvider`, `AirtableProjectionProvider`, `AccelEventsProjectionProvider` | yes, all of them | a deployment that really sends |

The same switch also selects the **inbound** Accelevents registration source
(`resolveRegistrationSource`): `fixture` answers from a deterministic in-repository roster and
`live` reads the real platform. It resolves on the request that runs a sync rather than at
startup, so a misconfigured `live` fails that request instead of taking every other route down
with it. Be exact about where that message goes: `ProviderConfigurationError` is not translated by
any route module, so the operator sees a generic 500 and the organizer's panel says only that the
platform could not be read. **The text naming the missing binding is in the Worker log, not in the
response** — check the logs rather than the screen when a `live` sync fails immediately.

The rule is otherwise identical: there is no fallback, and a sync must never report a count from
the fixture roster while an operator believes it read their registration platform. The organizer
surface prints the mode on screen for the same reason.

### Reaching a failure in `fixture` mode

The deterministic provider succeeds for every recipient except three sub-address tags, which let
a demo or a test produce a failed delivery from a real product action rather than from a seeded
row: `someone+bounce@…` is terminally rejected, `someone+timeout@…` fails retryably, and
`someone+malformed@…` returns an unparsable success. The tag must be the **whole** sub-address —
`alerts+bounces@corp.example` is somebody's real address and sends normally.

There is no third state, and that is the point. A `live` mode missing any variable **throws**,
naming every missing binding at once; it never falls back to a fake. The failure this rule exists
to prevent is a deployment that believes it is mailing speakers while appending to an in-memory
array. In the same spirit, `fixture` is refused when `ENVIRONMENT` names a production deployment
(`production`, `prod` or `live`, in any case).

**Where that throw happens, precisely.** `resolveProviders` is called from `drainOutbox`, which
the one-minute scheduled trigger invokes — **not** at module load and **not** on the request path.
So a misconfigured deployment does not fail to deploy and does not fail `/health`. What happens is:
the console keeps accepting sends and answering `202`, deliveries accumulate as `queued`, the
scheduled drain throws once a minute, and **nothing is ever sent**. Deliveries are not lost and
drain normally once configuration is fixed. This is the safe direction, but it is quiet: if you
are verifying a configuration change, watch the Worker's scheduled-invocation logs or the
delivery history, because a green deploy proves nothing about it.

## Configuration

All credentials are Worker **secrets** (`npx wrangler secret put NAME`), never `wrangler.toml`
vars, and never committed. Only non-secret identifiers — the Airtable base, table and column
names — are configuration.

| Binding | Mode | Secret | Meaning |
|---|---|---|---|
| `COMMUNICATIONS_PROVIDERS` | both | no | `fixture` or `live` |
| `EMAIL_API_ENDPOINT` | live | no | Full URL of the transactional mail send endpoint |
| `EMAIL_API_TOKEN` | live | **yes** | Bearer credential for that endpoint |
| `EMAIL_SENDER` | live | no | The From address the provider has authorized for the domain |
| `AIRTABLE_BASE_ID` | live | no | Target base |
| `AIRTABLE_TABLE_ID` | live | no | Target table |
| `AIRTABLE_TOKEN` | live | **yes** | Personal access token |
| `AIRTABLE_REFERENCE_FIELD` | live | no | Column holding the Greenroom reference; defaults to `Greenroom Ref` |
| `ACCELEVENTS_API_ENDPOINT` | live (outbound) | no | Full URL of the projection endpoint, POSTed to verbatim |
| `ACCELEVENTS_API_ORIGIN` | live (inbound) | no | Origin of the Accelevents API (`https://api.accelevents.com`); the registration read appends `/rest/events/{ref}/staff/allAttendees` and its pagination query. Separate from the endpoint above because one binding cannot be both a complete URL and a prefix |
| `ACCELEVENTS_TOKEN` | live | **yes** | Accelevents API key, sent verbatim in the published `AUTHENTICATION` header |
| `ACCELEVENTS_EVENT_REF` | live (inbound) | no | The Accelevents event whose registrations the inbound sync reads |
| `ACCELEVENTS_GREENROOM_EVENT_ID` | live (inbound) | no | The Greenroom event `ACCELEVENTS_EVENT_REF` corresponds to. Required, because one deployment-wide roster would otherwise answer every event that asks and import another conference's attendees into it; a sync for any other event is refused |
| `CALENDAR_ORGANIZER_EMAIL` | both | no | Fallback `ORGANIZER` for calendar invitations when `EMAIL_SENDER` is unset. Defaulted in `wrangler.toml` to a reserved `.invalid` address so the configurations that send no mail can still produce an invitation |

### Least privilege

- **Email.** A send-only API key. It needs no access to templates, contacts, suppression lists or
  account settings, and it must be scoped to the one authorized sender domain.
- **Airtable.** A personal access token scoped to the single target base with `data.records:read`
  and `data.records:write`. Not `schema.bases:write`: the adapter never creates or alters a
  column, and a missing column is meant to surface as an actionable failure rather than be
  silently created. The reference column must be unique in the table — it is the upsert merge key.
- **Accelevents.** The narrowest token the tenant offers for writing session/registration
  projections, plus read access to the one event's registration list, which is what the inbound
  sync needs. Note that the inbound direction is the one that reads people: it pulls names and
  addresses and turns them into speaker profiles, so this token is the only one here that touches
  attendee personal data, and it must be scoped to the single event named by
  `ACCELEVENTS_EVENT_REF`. It never needs access to payments, orders or account settings.

  Both directions share `ACCELEVENTS_TOKEN`. If the tenant can issue two — one write-only for
  projections, one read-only for registrations — prefer that, and split the binding then rather
  than pretending one credential is narrower than it is.

### Accelevents published-contract verification

Retrieved 2026-08-12 from Accelevents API reference v1.0. The inbound adapter now matches the
published `GET /rest/events/{eventurl}/staff/allAttendees` contract: the API key is sent verbatim
in `AUTHENTICATION`, pages are zero-indexed with `size=100` and `dataType=TICKET`, and the parser
reads `attendees`, `recordsTotal`, `attendeeId`, `firstName`, `lastName`, `email`, and `ticketType`.
The fixture uses the same response envelope and also carries documented fields Greenroom does not
consume (`barcode`, `status`, and `ticketStatus`), so fixture drift fails the contract suite.

This is documentation conformance, not a live smoke. API-key creation requires owner access to an
organizer/Enterprise account, and the API Key screen is unavailable on the free account checked
for issue #161. No Accelevents request has been made from this project. `GAP-012` therefore stays
open until a paid account supplies a credential and the staging smoke below is observed.

### Rotation and revocation

Rotate by setting the new secret and redeploying: `wrangler secret put EMAIL_API_TOKEN` then
`npm run deploy`. Deliveries in flight during the swap fail with `PROVIDER_UNAUTHORIZED:401`,
which is terminal — they do not burn retries against a dead credential. Recover them from the
organizer's history with the retry action once the new secret is live.

To revoke immediately, revoke at the provider **and** unset the token, then redeploy. The
scheduled drain then throws instead of sending. Note what this does *not* do: the deploy
succeeds, `/health` stays green, and the console keeps accepting sends — the only signal is the
cron exception. Confirm revocation at the provider, not by watching the deploy. Deliveries
accumulate as `queued` and drain when configuration is restored; nothing is lost.

## Normalized outcomes

Every adapter maps its HTTP result through `http-outcome.ts`, so `error_code` in the delivery
history means one thing across all three:

| Code | Kind | Cause | Operator action |
|---|---|---|---|
| `PROVIDER_TIMEOUT` | retryable | the provider answered 408 | none; the outbox backs off |
| `PROVIDER_RATE_LIMITED` | retryable | 429 | none unless persistent; then reduce send volume |
| `PROVIDER_UNAVAILABLE:5xx` | retryable | provider outage | watch; bounded at three attempts |
| `PROVIDER_UNREACHABLE` | retryable | DNS, TLS, dropped connection, **or our own 10s ceiling** | check network/egress; a whole channel timing out usually means the provider is degraded |
| `PROVIDER_UNAUTHORIZED:401/403` | terminal | revoked, rotated or misscoped credential | fix the secret, redeploy, retry the delivery |
| `PROVIDER_REJECTED:4xx` | terminal | the provider understood and refused | fix the data the code points at, then retry |
| `MALFORMED_PROVIDER_RESPONSE` | terminal | 2xx we cannot parse, or with no reference | inspect the provider's own logs; the effect may have happened |
| `RECIPIENT_NOT_ADDRESSABLE` | terminal | `recipient_ref` is not a mail address | correct the recipient reference at the source |
| `MESSAGE_NOT_RENDERED` | terminal | an email delivery carrying no rendered body | a bug: the delivery was written outside the service |
| `CALENDAR_INVITE_MALFORMED` | terminal | `payload.calendarInvite` is present but unusable | a bug: the invitation was built outside `buildSpeakerInvite`. Sending the covering note without the invitation would tell a speaker a meeting exists and give them no way to accept it, so nothing is sent |
| `RETRY_EXHAUSTED:<code>` | terminal | three retryable attempts | the underlying code names the cause |

Two more codes appear in the history that no adapter produces — the outbox writes them itself:
`PROJECTION_SUPERSEDED` (terminal; a newer version for the same destination/event/resource was
requested before this one ran, so it was never sent) and `UNEXPECTED_PROVIDER_ERROR` (retryable;
an adapter threw rather than returning an outcome, which is a bug in the adapter).

One edge worth knowing before it confuses somebody at 3am: the 10-second ceiling covers reading
the body as well as getting the headers. A provider that answers at 9.9s and then streams slowly
aborts mid-body, which reads as an unparsable success — `MALFORMED_PROVIDER_RESPONSE`, terminal,
not retried. That is the safe direction (the send may well have happened, and retrying would
duplicate it) but it means a *terminal* malformed result can have a timeout behind it rather than
a genuinely bad payload. Check the provider's own logs for the delivery before assuming the
response was malformed.

A retryable failure becomes terminal on the third attempt. Recovery is the organizer's explicit
retry (`POST /api/communications/deliveries/{id}/retry`), which adds one further attempt and never
rewrites the previous ones — the procedure is in
[integration architecture](../architecture/integrations.md#delivery-lifecycle-and-recovery).

## What is not logged

`delivery.attempt` is the only line the outbox emits per provider call. It carries the delivery
id, channel, trigger type, attempt sequence, normalized outcome, error code, provider reference,
and `staleProjectionRepaired`. It deliberately carries **no** recipient, rendered message,
payload or credential: this goes to a shared sink and the row itself is available under the same
authorization as the history view.

`staleProjectionRepaired` is true when this delivery's projection write was refused because a
newer version had already been recorded, and the delivery owning that newer version has been
re-queued to re-send it. That is usually staleness — this call reached the provider after a newer
one — but it is *commit* order, not provider-landing order, so it over-reports a harmless
re-send when a slow round trip commits late, and cannot see the case where the late call commits
first. Read it as "this projection write lost". It is the only externally visible trace of a race
that is otherwise invisible — both calls succeeded, both attempts read `succeeded`, and the row
that lost looks like an ordinary success. Seeing it go from never to often means projections are
being enqueued faster than the outbox drains them. The mechanism, and why a conditional write is
not available to prevent it, are in
[integration architecture](../architecture/integrations.md#a-late-projection-can-leave-the-external-system-stale).

The idempotency key is deliberately **not** logged either, which is worth knowing if you go
looking for it. `POST /api/communications/deliveries` lets a caller choose that key, so one
keyed `invite:ada@example.test` would put an address into a shared sink. The delivery id is
generated here and correlates just as well.

No response body ever reaches an `error_code`. Bodies can echo a recipient address, a record's
contents, or a token quoted back in an error message, and `error_code` is stored on an immutable
attempt and rendered in the organizer's UI. The status is enough to act on.

Keying deliveries by identifier rather than by address is still the right habit — the key is
stored on the row and shown in the organizer's history — but it is no longer what stands between
an address and the shared log sink.

## Rate limits and volume

The scheduled drain runs every minute and takes at most 100 deliveries per invocation **in total
across all three channels**, so the ceiling is ~100 provider calls per minute however they are
distributed. Airtable's published limit is 5 requests per second per base and the mail provider's
depends on plan; both are above that ceiling, and 429s are retryable with backoff regardless.
Raising the per-invocation limit means checking those numbers again.

One send from the console is capped separately, at 500 recipients, and refuses before writing
anything rather than exhausting a Worker invocation partway through and leaving half an event
queued while reporting failure.

## Staging smoke — required, and not yet performed

**This has not been run. No credential for any of these three providers exists in this
repository, and none was used to build the adapters.** The request shapes are written from each
provider's documented contract, not from an observed exchange, and the contract suite
(`apps/api/test/provider-contract.test.ts`) stubs `fetch` — it proves our normalization, not their
API. Accelevents is the least certain of the three.

Before enabling `live` anywhere real, someone with non-production credentials must run this and
record the result here:

1. Provision a sandbox for each provider: a mail account in test mode, a scratch Airtable base
   with the reference column, an Accelevents sandbox tenant. Issue least-privilege credentials as
   above.
2. Deploy a staging Worker with `COMMUNICATIONS_PROVIDERS=live` and those secrets.
3. Confirm the fail-safe first: deploy once with one token deliberately absent. The deploy will
   **succeed** — check the scheduled-invocation log for the thrown error naming the binding, and
   confirm a delivery enqueued in that state stays `queued` and is never sent.
4. Send one delivery per channel to a sandbox recipient and confirm each reaches `succeeded` with
   a provider reference that resolves in that provider's own dashboard. Only email is reachable
   from the console — the two projection channels have no organizer surface yet (issue #58), so
   drive them with an authorized `POST /api/communications/deliveries`:

   ```json
   {
     "organizationId": "…", "eventId": "…",
     "idempotencyKey": "smoke:airtable:1",
     "triggerType": "projection.requested",
     "channel": "airtable",
     "recipientRef": "session:smoke-1",
     "projectionVersion": 1,
     "payload": { "Title": "Smoke test session" }
   }
   ```

   The same body with `"channel": "accelevents"` and a fresh key covers the third. Both require
   `communications:manage` in the owning organization.
5. Force each failure mode: an invalid recipient (terminal), a revoked token (terminal 401), a
   deleted Airtable column (terminal 4xx). Confirm the normalized code and that recovery works
   after the cause is fixed.
6. Re-apply the same versioned Airtable projection twice and confirm one record, updated, not two.
7. Record the date, the commit, and any request-shape corrections in this section.

Until step 7 exists, treat `live` as unverified and keep deployments on `fixture`.
