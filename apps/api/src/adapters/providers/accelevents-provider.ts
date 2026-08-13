/**
 * The live Accelevents projection adapter.
 *
 * Same contract as the Airtable adapter — outbound, versioned, idempotent — over a configured
 * endpoint. One POST per delivery, carrying the resource reference, the projection version and
 * the payload, with the outbox's idempotency key as the provider's duplicate-suppression key.
 *
 * **What this adapter has not been verified against.** No Accelevents credential exists in this
 * repository and none was used to build it, so the request shape below is the documented
 * integration contract rather than an observed one, and it has never been exchanged with the
 * live API. It is contract-tested against a stub and configuration-gated off by default. Before
 * this is enabled anywhere real, someone with a sandbox tenant has to run the staging smoke in
 * `docs/engineering/communications-providers.md` and correct whatever the API actually wants.
 * Treat a green test suite here as evidence about our normalization, not about their API.
 *
 * @spec PORT-ACCELEVENTS PRD-INT-001
 */
import type { DeliveryProvider, ProviderResult } from "../../application/communications/ports";
import type { Delivery } from "../../domain/communications/delivery";
import {
  MALFORMED,
  PROVIDER_TIMEOUT_MS,
  UNREACHABLE,
  outcomeForStatus,
  readJsonBody,
} from "./http-outcome";

export interface AccelEventsProviderConfiguration {
  /** Full URL of the projection endpoint. */
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class AccelEventsProjectionProvider implements DeliveryProvider {
  constructor(
    private readonly configuration: AccelEventsProviderConfiguration,
    private readonly fetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async deliver(delivery: Delivery): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await this.fetch(this.configuration.endpoint, {
        method: "POST",
        headers: {
          AUTHENTICATION: this.configuration.token,
          "content-type": "application/json",
          // Keyed per *attempt*, not per delivery, and that difference is load-bearing.
          //
          // This request is an upsert on `externalRef`, so repeating it converges by construction
          // and needs no provider-side suppression to be safe. Keying it on the delivery instead
          // would make a provider that honours the header replay its cached first response — and
          // the stale-projection repair works precisely by re-sending the same delivery, so the
          // repair would be answered "already done" while the external system kept the older
          // payload, with nothing left to detect it.
          "idempotency-key": `${delivery.idempotencyKey}:${delivery.attemptCount + 1}`,
        },
        body: JSON.stringify({
          externalRef: delivery.recipientRef,
          version: delivery.projectionVersion ?? 0,
          eventRef: delivery.eventId,
          fields: delivery.payload,
        }),
        signal: AbortSignal.timeout(this.configuration.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      });
    } catch {
      // ERROR-INTENT: transport failures are normalized into a bounded retry; the underlying
      // message is untrusted and never stored.
      return UNREACHABLE;
    }

    const failure = outcomeForStatus(response.status);
    if (failure) return failure;
    const body = await readJsonBody(response);
    const reference =
      body && typeof body === "object" && "id" in body && typeof body.id === "string"
        ? body.id
        : null;
    return reference
      ? { kind: "success", providerReference: `accelevents:${reference}` }
      : MALFORMED;
  }
}
