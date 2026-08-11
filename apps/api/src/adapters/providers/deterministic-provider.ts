import type { DeliveryProvider, ProviderResult } from "../../application/communications/ports";
import type { Delivery } from "../../domain/communications/delivery";

export type FakeProviderBehavior = "success" | "timeout" | "malformed" | "terminal";

// @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS
export class DeterministicProvider implements DeliveryProvider {
  readonly calls: Delivery[] = [];
  constructor(private readonly behavior: FakeProviderBehavior = "success") {}

  async deliver(delivery: Delivery): Promise<ProviderResult> {
    this.calls.push(delivery);
    if (this.behavior === "timeout") return { kind: "retryable", code: "PROVIDER_TIMEOUT" };
    if (this.behavior === "malformed")
      return { kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" };
    if (this.behavior === "terminal") return { kind: "terminal", code: "PROVIDER_REJECTED" };
    return { kind: "success", providerReference: `fake:${delivery.channel}:${delivery.id}` };
  }
}
