import type { DeliveryProvider, ProviderResult } from "../../application/communications/ports";
import type { Delivery } from "../../domain/communications/delivery";

/**
 * The provider a channel gets when nobody configured it on a deployment that must not fake.
 *
 * `COMMUNICATIONS_PROVIDERS` used to be one switch over three channels, so a deployment that
 * wanted real email had to hold Airtable and Accelevents credentials it did not have. The switch
 * is per channel now, and an unconfigured channel ordinarily falls back to
 * `DeterministicProvider` — which is what keeps the demo's projections working on a deployment
 * whose mail is live.
 *
 * That fallback is exactly what `resolveProviders` refuses where `ENVIRONMENT` names production:
 * a deployment that believes it is live must not report `fake:` references for a channel nobody
 * configured. This is what it gets instead. Every delivery is refused, terminally, naming the
 * bindings that would make the channel real — so the failure is in the delivery history where an
 * organizer sees it, and an operator who then sets the bindings can retry the row.
 *
 * **It never returns success**, which is the whole of its contract. Terminal rather than
 * retryable because a missing binding does not resolve itself inside three attempts, and the
 * console's retry is the affordance for after it has been set.
 *
 * @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
 */
export class UnconfiguredProvider implements DeliveryProvider {
  constructor(
    private readonly channel: string,
    /** Named in the refusal so an operator reads what to set, never what is already set. */
    readonly bindings: readonly string[],
  ) {}

  async deliver(_delivery: Delivery): Promise<ProviderResult> {
    return {
      kind: "terminal",
      // The delivery row already records its channel, so the code does not repeat it; the
      // bindings do not belong in an error code that a log sink groups on.
      code: "PROVIDER_NOT_CONFIGURED",
    };
  }

  /** What an operator has to set for this channel to stop refusing. Never a value. */
  describe(): string {
    return `${this.channel} requires ${this.bindings.join(", ")}`;
  }
}
