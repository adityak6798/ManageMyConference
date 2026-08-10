// @acceptance ACC-INTEGRATION
import { describe, expect, it } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import { CommunicationsService } from "../src/application/communications/communications-service";
import { OutboxWorker } from "../src/application/communications/outbox-worker";
import type { Actor } from "../src/application/identity/actor";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["events:read"]) }],
  capabilities: new Set(["communications:manage"]),
};

const harness = (behavior: "success" | "timeout" | "malformed" | "terminal" = "success") => {
  let id = 0;
  let now = new Date("2026-08-10T12:00:00.000Z");
  const repository = new MemoryCommunicationsRepository();
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
        candidateEventId === eventId && candidateOrganizationId === organizationId,
    },
    newId: () => `id-${++id}`,
    now: () => now,
  });
  const provider = new DeterministicProvider(behavior);
  const worker = new OutboxWorker(
    repository,
    { email: provider, airtable: provider, accelevents: provider },
    { newId: () => `id-${++id}`, now: () => now },
  );
  return {
    repository,
    service,
    provider,
    worker,
    advance: (milliseconds: number) => (now = new Date(now.getTime() + milliseconds)),
  };
};

async function templateAndTrigger(
  test: ReturnType<typeof harness>,
  overrides: Partial<Parameters<CommunicationsService["trigger"]>[1]> = {},
) {
  await test.service.createTemplate(organizer, {
    organizationId,
    key: "speaker-invite",
    version: 1,
    channel: "email",
    subject: "You're invited",
    body: "Hello {{speaker}}",
  });
  return test.service.trigger(organizer, {
    organizationId,
    eventId,
    idempotencyKey: "speaker:42:invite:v1",
    triggerType: "speaker.invited",
    channel: "email",
    recipientRef: "speaker:42",
    payload: { speaker: "Ada" },
    templateKey: "speaker-invite",
    ...overrides,
  });
}

describe("communications outbox", () => {
  it("enqueues a typed trigger exactly once and preserves its template version", async () => {
    const test = harness();
    const first = await templateAndTrigger(test);
    const duplicate = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "speaker:42:invite:v1",
      triggerType: "speaker.invited",
      channel: "email",
      recipientRef: "speaker:42",
      payload: {},
      templateKey: "speaker-invite",
    });
    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({ state: "queued", templateVersion: 1 });
  });

  it.each(["success", "malformed", "terminal"] as const)(
    "records an immutable observable attempt for %s",
    async (behavior) => {
      const test = harness(behavior);
      const delivery = await templateAndTrigger(test);
      await expect(test.worker.runOne()).resolves.toBe(true);
      const current = await test.repository.get(delivery.id);
      expect(current?.state).toBe(behavior === "success" ? "succeeded" : "terminal");
      expect(await test.repository.attempts(delivery.id)).toHaveLength(1);
    },
  );

  it("backs off retryable failures and supports explicit recovery", async () => {
    const test = harness("timeout");
    const delivery = await templateAndTrigger(test);
    await test.worker.runOne();
    expect((await test.repository.get(delivery.id))?.state).toBe("retrying");
    await expect(test.worker.runOne()).resolves.toBe(false);
    await test.service.retry(organizer, organizationId, delivery.id);
    await expect(test.worker.runOne()).resolves.toBe(true);
    expect(await test.repository.attempts(delivery.id)).toHaveLength(2);
  });

  it("stores an idempotent versioned provider projection after success", async () => {
    const test = harness();
    const delivery = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "projection:session:42:v3",
      triggerType: "projection.requested",
      channel: "airtable",
      recipientRef: "session:42",
      payload: { title: "Reliable Systems" },
      projectionVersion: 3,
    });
    await test.worker.runOne();
    expect(test.repository.projections.get(`airtable:${eventId}:session:42`)).toMatchObject({
      version: 3,
      deliveryId: delivery.id,
    });
  });

  it("rejects cross-tenant event references and incomplete projection triggers", async () => {
    const test = harness();
    await expect(
      test.service.trigger(organizer, {
        organizationId,
        eventId: "00000000-0000-4000-8000-000000000099",
        idempotencyKey: "outside",
        triggerType: "projection.requested",
        channel: "airtable",
        recipientRef: "session:outside",
        payload: {},
        projectionVersion: 1,
      }),
    ).rejects.toThrow("Event access denied");
    const otherOrganizationId = "00000000-0000-4000-8000-000000000020";
    const otherEventId = "00000000-0000-4000-8000-000000000002";
    const multiOrganizationActor: Actor = {
      ...organizer,
      organizations: [{ id: organizationId }, { id: otherOrganizationId }],
      eventAccess: [
        ...organizer.eventAccess,
        { eventId: otherEventId, role: "organizer", capabilities: new Set(["events:read"]) },
      ],
    };
    await expect(
      test.service.trigger(multiOrganizationActor, {
        organizationId,
        eventId: otherEventId,
        idempotencyKey: "crossed-pair",
        triggerType: "projection.requested",
        channel: "airtable",
        recipientRef: "session:crossed",
        payload: {},
        projectionVersion: 1,
      }),
    ).rejects.toThrow("Event organization access denied");
    await expect(
      test.service.trigger(organizer, {
        organizationId,
        eventId,
        idempotencyKey: "missing-version",
        triggerType: "projection.requested",
        channel: "airtable",
        recipientRef: "session:1",
        payload: {},
      }),
    ).rejects.toThrow("requires a version");
  });

  it("normalizes thrown provider failures and reclaims abandoned leases", async () => {
    const test = harness();
    const delivery = await templateAndTrigger(test);
    const throwing = {
      deliver: async () => {
        throw new Error("socket closed");
      },
    };
    const worker = new OutboxWorker(
      test.repository,
      { email: throwing, airtable: throwing, accelevents: throwing },
      { newId: () => crypto.randomUUID(), now: () => new Date("2026-08-10T12:00:00.000Z") },
    );
    await worker.runOne();
    expect(await test.repository.attempts(delivery.id)).toEqual([
      expect.objectContaining({
        outcome: "retryable_failure",
        errorCode: "UNEXPECTED_PROVIDER_ERROR",
      }),
    ]);

    await test.repository.retry(delivery.id, organizationId, "2026-08-10T12:00:00.000Z");
    await test.repository.leaseNext("2026-08-10T12:00:00.000Z", "abandoned");
    await expect(
      test.repository.leaseNext("2026-08-10T12:04:59.000Z", "too-soon"),
    ).resolves.toBeNull();
    await expect(
      test.repository.leaseNext("2026-08-10T12:05:00.000Z", "reclaimed"),
    ).resolves.toMatchObject({ id: delivery.id, leaseToken: "reclaimed" });
    await expect(
      test.repository.retry(delivery.id, organizationId, "2026-08-10T12:05:00.000Z"),
    ).rejects.toThrow("currently leased");
  });
});
