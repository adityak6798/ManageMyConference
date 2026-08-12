# Communications providers: configuration and operations

Status: canonical | Owner: communications-integrations | IDs: `PORT-EMAIL`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS` | Last verified: 2026-08-11

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

There is no third state, and that is the point. A `live` mode missing any variable **throws at
startup** and names the missing bindings; it never falls back to a fake. The failure this rule
exists to prevent is a deployment that believes it is mailing speakers while appending to an
in-memory array. In the same spirit, `fixture` is refused outright when `ENVIRONMENT=production`.

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
| `ACCELEVENTS_API_ENDPOINT` | live | no | Full URL of the projection endpoint |
| `ACCELEVENTS_TOKEN` | live | **yes** | Bearer credential for that endpoint |

### Least privilege

- **Email.** A send-only API key. It needs no access to templates, contacts, suppression lists or
  account settings, and it must be scoped to the one authorized sender domain.
- **Airtable.** A personal access token scoped to the single target base with `data.records:read`
  and `data.records:write`. Not `schema.bases:write`: the adapter never creates or alters a
  column, and a missing column is meant to surface as an actionable failure rather than be
  silently created. The reference column must be unique in the table — it is the upsert merge key.
- **Accelevents.** The narrowest token the tenant offers for writing session/registration
  projections. It never needs read access to attendee personal data.

### Rotation and revocation

Rotate by setting the new secret and redeploying: `wrangler secret put EMAIL_API_TOKEN` then
`npm run deploy`. Deliveries in flight during the swap fail with `PROVIDER_UNAUTHORIZED:401`,
which is terminal — they do not burn retries against a dead credential. Recover them from the
organizer's history with the retry action once the new secret is live.

To revoke immediately, revoke at the provider **and** set `COMMUNICATIONS_PROVIDERS` to something
invalid (or unset the token) and redeploy: startup then refuses rather than sending. Deliveries
accumulate as `queued` and drain when configuration is restored — nothing is lost.

## Normalized outcomes

Every adapter maps its HTTP result through `http-outcome.ts`, so `error_code` in the delivery
history means one thing across all three:

| Code | Kind | Cause | Operator action |
|---|---|---|---|
| `PROVIDER_TIMEOUT` | retryable | 408, or our own 10s ceiling | none; the outbox backs off |
| `PROVIDER_RATE_LIMITED` | retryable | 429 | none unless persistent; then reduce send volume |
| `PROVIDER_UNAVAILABLE:5xx` | retryable | provider outage | watch; bounded at three attempts |
| `PROVIDER_UNREACHABLE` | retryable | DNS, TLS, dropped connection | check network/egress |
| `PROVIDER_UNAUTHORIZED:401/403` | terminal | revoked, rotated or misscoped credential | fix the secret, redeploy, retry the delivery |
| `PROVIDER_REJECTED:4xx` | terminal | the provider understood and refused | fix the data the code points at, then retry |
| `MALFORMED_PROVIDER_RESPONSE` | terminal | 2xx we cannot parse, or with no reference | inspect the provider's own logs; the effect may have happened |
| `RECIPIENT_NOT_ADDRESSABLE` | terminal | `recipient_ref` is not a mail address | correct the recipient reference at the source |
| `MESSAGE_NOT_RENDERED` | terminal | an email delivery carrying no rendered body | a bug: the delivery was written outside the service |
| `RETRY_EXHAUSTED:<code>` | terminal | three retryable attempts | the underlying code names the cause |

A retryable failure becomes terminal on the third attempt. Recovery is the organizer's explicit
retry (`POST /api/communications/deliveries/{id}/retry`), which adds one further attempt and never
rewrites the previous ones — the procedure is in
[integration architecture](../architecture/integrations.md#delivery-lifecycle-and-recovery).

## What is not logged

`delivery.attempt` is the only line the outbox emits per provider call. It carries the delivery
id, idempotency key, channel, trigger type, attempt sequence, normalized outcome, error code and
provider reference. It deliberately carries **no** recipient, rendered message, payload or
credential: this goes to a shared sink and the row itself is available under the same
authorization as the history view.

No response body ever reaches an `error_code`. Bodies can echo a recipient address, a record's
contents, or a token quoted back in an error message, and `error_code` is stored on an immutable
attempt and rendered in the organizer's UI. The status is enough to act on.

## Rate limits and volume

The scheduled drain runs every minute and takes at most 100 deliveries per invocation, so the
ceiling is ~100 provider calls per minute per channel. Airtable's published limit is 5 requests
per second per base and the mail provider's depends on plan; both are above that ceiling, and
429s are retryable with backoff regardless. Raising the per-invocation limit means checking those
numbers again.

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
3. Confirm startup refuses first: deploy once with one token deliberately absent and check the
   error names the binding and sends nothing.
4. Send one delivery per channel from the organizer console to a sandbox recipient. Confirm each
   reaches `succeeded` with a provider reference that resolves in that provider's own dashboard.
5. Force each failure mode: an invalid recipient (terminal), a revoked token (terminal 401), a
   deleted Airtable column (terminal 4xx). Confirm the normalized code and that recovery works
   after the cause is fixed.
6. Re-apply the same versioned Airtable projection twice and confirm one record, updated, not two.
7. Record the date, the commit, and any request-shape corrections in this section.

Until step 7 exists, treat `live` as unverified and keep deployments on `fixture`.
