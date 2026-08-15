// @acceptance ACC-INTEGRATION
// @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS
//
// The fixture provider is what every local run, CI run, Playwright run and the demo sends
// through, so its failure-injection markers are production behaviour for those environments and
// need to be exactly as narrow as they claim.
import { describe, expect, it } from "vitest";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import type { Delivery } from "../src/domain/communications/delivery";

const delivery = (recipientRef: string): Delivery => ({
  id: "delivery-1",
  organizationId: "org-1",
  eventId: "event-1",
  idempotencyKey: "key-1",
  triggerType: "speaker.invited",
  channel: "email",
  templateId: "template-1",
  templateVersion: 1,
  recipientRef,
  recipientTrust: "account" as const,
  payload: {},
  renderedSubject: "Subject",
  renderedBody: "Body",
  projectionVersion: null,
  state: "queued",
  attemptCount: 0,
  nextAttemptAt: "2026-08-10T12:00:00.000Z",
  leaseToken: null,
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
});

describe("deterministic provider fixture outcomes", () => {
  it("succeeds for an ordinary recipient", async () => {
    const result = await new DeterministicProvider().deliver(delivery("ada@example.test"));

    expect(result).toEqual({ kind: "success", providerReference: "fake:email:delivery-1" });
  });

  it.each([
    ["ada+bounce@example.test", { kind: "terminal", code: "PROVIDER_REJECTED" }],
    ["ada+timeout@example.test", { kind: "retryable", code: "PROVIDER_TIMEOUT" }],
    ["ada+malformed@example.test", { kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" }],
  ])(
    "steers on the %s sub-address tag, so failure is reachable from the product",
    async (recipientRef, expected) => {
      expect(await new DeterministicProvider().deliver(delivery(recipientRef))).toEqual(expected);
    },
  );

  it.each([
    // Real addresses somebody uses. A substring match marked all of these permanently rejected.
    "alerts+bounces@corp.example",
    "ops+timeouts@corp.example",
    "ada@bounce.example",
    "bounce@example.test",
    "ada+bounce.reports@example.test",
  ])("leaves the legitimate address %s alone", async (recipientRef) => {
    const result = await new DeterministicProvider().deliver(delivery(recipientRef));

    expect(result).toMatchObject({ kind: "success" });
  });

  it("still lets a constructor behavior pin every outcome, for outbox tests", async () => {
    expect(
      await new DeterministicProvider("timeout").deliver(delivery("ada@example.test")),
    ).toEqual({ kind: "retryable", code: "PROVIDER_TIMEOUT" });
  });
});
