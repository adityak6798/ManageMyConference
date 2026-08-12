/**
 * The live email adapter.
 *
 * Speaks to a transactional mail API over HTTPS: one POST per delivery, carrying the message the
 * delivery already rendered. It composes nothing — by the time a delivery reaches a provider the
 * subject and body are fixed, pinned to a template version, so what a retry sends is what the
 * first attempt sent.
 *
 * @spec PORT-EMAIL PRD-COM-001 PRD-INT-001
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

export interface EmailProviderConfiguration {
  /** Full URL of the send endpoint. */
  readonly endpoint: string;
  /** Bearer credential. Held only here and never logged, stored, or returned. */
  readonly token: string;
  /** The From address the provider has authorized for this domain. */
  readonly sender: string;
  readonly timeoutMs?: number;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A live delivery must resolve to something a mail server can accept.
 *
 * The outbox's `recipient_ref` is an opaque reference by design, and plenty of legitimate ones —
 * `session:99`, `speaker:queued` — are not addresses. Rather than guess, this adapter accepts a
 * bare address or the `mailto:` form and refuses anything else terminally: repeating the send
 * will not make an unaddressable reference deliverable, and the operator needs to see that
 * rather than watch three attempts fail.
 */
const addressFor = (recipientRef: string): string | null => {
  const candidate = recipientRef.startsWith("mailto:") ? recipientRef.slice(7) : recipientRef;
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(candidate) ? candidate : null;
};

export class HttpEmailProvider implements DeliveryProvider {
  constructor(
    private readonly configuration: EmailProviderConfiguration,
    private readonly fetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async deliver(delivery: Delivery): Promise<ProviderResult> {
    const to = addressFor(delivery.recipientRef);
    if (!to) return { kind: "terminal", code: "RECIPIENT_NOT_ADDRESSABLE" };
    if (delivery.renderedBody === null) return { kind: "terminal", code: "MESSAGE_NOT_RENDERED" };

    let response: Response;
    try {
      response = await this.fetch(this.configuration.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.token}`,
          "content-type": "application/json",
          // The provider's own duplicate suppression, keyed by the same value the outbox
          // dedupes on. A lease that expires mid-flight and a re-attempted send then converge
          // on one message at the provider too, not just one row here.
          "idempotency-key": delivery.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.configuration.sender,
          to,
          subject: delivery.renderedSubject ?? "",
          text: delivery.renderedBody,
        }),
        signal: AbortSignal.timeout(this.configuration.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      });
    } catch {
      // ERROR-INTENT: a transport failure carries an untrusted message that can name internal
      // hosts; it is normalized into a bounded retry and the message is deliberately dropped.
      return UNREACHABLE;
    }

    const failure = outcomeForStatus(response.status);
    if (failure) return failure;
    const body = await readJsonBody(response);
    const reference =
      body && typeof body === "object" && "id" in body && typeof body.id === "string"
        ? body.id
        : null;
    // A send the provider accepted but did not identify cannot be correlated later, which is the
    // whole point of keeping a provider reference on the attempt.
    return reference ? { kind: "success", providerReference: `email:${reference}` } : MALFORMED;
  }
}
