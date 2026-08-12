import type { DeliveryProvider, ProviderResult } from "../../application/communications/ports";
import type { Delivery } from "../../domain/communications/delivery";

export type FakeProviderBehavior = "success" | "timeout" | "malformed" | "terminal";

/**
 * The credential-free provider every local run, test and demo sends through.
 *
 * Two ways to steer it, and they answer different questions:
 *
 * - The constructor behavior pins every call to one outcome. Tests use it to drive the outbox
 *   through retry and terminal paths without needing a recipient that means anything.
 * - The recipient's own address decides, when the behavior is left at its default. This is what
 *   makes failure reachable from the product rather than only from a seeded row: sending to
 *   `someone+bounce@example.test` produces a rejected delivery an organizer can find in the
 *   history and retry, the way a real bounced address would. The convention mirrors the
 *   sub-address form mail providers already use for test recipients, and the tag must match
 *   exactly — `alerts+bounces@corp.example` is somebody's real address, not a fixture.
 *
 * @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS
 */
const FIXTURE_OUTCOMES: readonly (readonly [string, ProviderResult])[] = [
  ["bounce", { kind: "terminal", code: "PROVIDER_REJECTED" }],
  ["timeout", { kind: "retryable", code: "PROVIDER_TIMEOUT" }],
  ["malformed", { kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" }],
];

/**
 * The exact sub-address tag, or null.
 *
 * Anchored rather than a substring search: `alerts+bounces@corp.example` is a legitimate address
 * somebody really uses, and a fixture that quietly marks it permanently rejected is worse than
 * no fixture at all. Only `name+bounce@host` — the whole tag, in the local part — steers.
 */
const fixtureTag = (recipientRef: string): string | null => {
  const at = recipientRef.lastIndexOf("@");
  if (at < 0) return null;
  const plus = recipientRef.lastIndexOf("+", at);
  return plus < 0 ? null : recipientRef.slice(plus + 1, at);
};

export class DeterministicProvider implements DeliveryProvider {
  readonly calls: Delivery[] = [];
  constructor(private readonly behavior: FakeProviderBehavior = "success") {}

  async deliver(delivery: Delivery): Promise<ProviderResult> {
    this.calls.push(delivery);
    if (this.behavior === "timeout") return { kind: "retryable", code: "PROVIDER_TIMEOUT" };
    if (this.behavior === "malformed")
      return { kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" };
    if (this.behavior === "terminal") return { kind: "terminal", code: "PROVIDER_REJECTED" };
    const tag = fixtureTag(delivery.recipientRef);
    const fixture = FIXTURE_OUTCOMES.find(([marker]) => marker === tag);
    if (fixture) return fixture[1];
    return { kind: "success", providerReference: `fake:${delivery.channel}:${delivery.id}` };
  }
}
