// @acceptance ACC-INTEGRATION
import { describe, expect, it } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import {
  CommunicationsService,
  SPEAKER_MERGE_FIELDS,
} from "../src/application/communications/communications-service";
import { CommunicationsInputError } from "../src/application/communications/errors";
import {
  type DeliveryAttemptRecord,
  OutboxWorker,
} from "../src/application/communications/outbox-worker";
import type { DeliveryProvider } from "../src/application/communications/ports";
import type { Actor } from "../src/application/identity/actor";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [
    {
      eventId,
      role: "organizer",
      capabilities: new Set(["events:read", "communications:manage"]),
    },
  ],
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
    // A second request under the same key returns the first delivery, and the message that was
    // composed then is the message that stands: the later payload does not rewrite it.
    const duplicate = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "speaker:42:invite:v1",
      triggerType: "speaker.invited",
      channel: "email",
      recipientRef: "speaker:42",
      payload: { speaker: "Someone else" },
      templateKey: "speaker-invite",
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.renderedBody).toBe("Hello Ada");
    expect(first).toMatchObject({ state: "queued", templateVersion: 1 });
  });

  it("hands the provider the rendered message, and logs the attempt without it", async () => {
    const test = harness();
    const records: Record<string, unknown>[] = [];
    const worker = new OutboxWorker(
      test.repository,
      { email: test.provider, airtable: test.provider, accelevents: test.provider },
      { newId: () => crypto.randomUUID(), now: () => new Date("2026-08-10T12:00:00.000Z") },
      { attempt: (record) => records.push({ ...record }) },
    );
    const delivery = await templateAndTrigger(test, {
      recipientRef: "ada@example.test",
      payload: { speaker: "Ada" },
    });

    await worker.runOne();

    // What a human would receive reached the provider — not just the template id.
    expect(test.provider.calls[0]?.renderedSubject).toBe("You're invited");
    expect(test.provider.calls[0]?.renderedBody).toBe("Hello Ada");
    // The operational log correlates and nothing more: no recipient, no message, no payload.
    const [record] = records;
    expect(record).toMatchObject({ deliveryId: delivery.id, outcome: "succeeded", sequence: 1 });
    expect(JSON.stringify(record)).not.toContain("ada@example.test");
    expect(JSON.stringify(record)).not.toContain("Hello Ada");
    // Nor the idempotency key: a caller of POST /deliveries chooses it and could key a delivery
    // by the recipient's address.
    expect(record).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(record)).not.toContain(delivery.idempotencyKey);
  });

  it("refuses a trigger whose payload cannot fill the template it names", async () => {
    const test = harness();
    await test.service.createTemplate(organizer, {
      organizationId,
      key: "speaker-invite",
      version: 1,
      channel: "email",
      subject: "You're invited",
      body: "Hello {{speaker}}",
    });

    // Half a message reaching a speaker is worse than a delivery that refuses to enqueue.
    await expect(
      test.service.trigger(organizer, {
        organizationId,
        eventId,
        idempotencyKey: "speaker:42:invite:v1",
        triggerType: "speaker.invited",
        channel: "email",
        recipientRef: "speaker:42",
        payload: {},
        templateKey: "speaker-invite",
      }),
    ).rejects.toThrow("{{speaker}}");
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

  it("denies recovery when an organization organizer is not the delivery event organizer", async () => {
    const test = harness("timeout");
    const delivery = await templateAndTrigger(test);
    await test.worker.runOne();
    const mixedRoleActor: Actor = {
      ...organizer,
      eventAccess: [{ eventId, role: "reviewer", capabilities: new Set(["events:read"]) }],
    };
    await expect(test.service.retry(mixedRoleActor, organizationId, delivery.id)).rejects.toThrow(
      "Actor lacks communications:manage for event",
    );
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
    ).rejects.toThrow("Actor lacks communications:manage for event");
    const otherOrganizationId = "00000000-0000-4000-8000-000000000020";
    const otherEventId = "00000000-0000-4000-8000-000000000002";
    const multiOrganizationActor: Actor = {
      ...organizer,
      organizations: [{ id: organizationId }, { id: otherOrganizationId }],
      eventAccess: [
        ...organizer.eventAccess,
        {
          eventId: otherEventId,
          role: "organizer",
          capabilities: new Set(["events:read", "communications:manage"]),
        },
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

  it("terminalizes retryable failures after three observable attempts", async () => {
    const test = harness("timeout");
    const delivery = await templateAndTrigger(test);
    await test.worker.runOne();
    test.advance(1_000);
    await test.worker.runOne();
    test.advance(2_000);
    await test.worker.runOne();
    expect(await test.repository.get(delivery.id)).toMatchObject({
      state: "terminal",
      attemptCount: 3,
    });
    expect(await test.repository.attempts(delivery.id)).toEqual([
      expect.objectContaining({ outcome: "retryable_failure" }),
      expect.objectContaining({ outcome: "retryable_failure" }),
      expect.objectContaining({
        outcome: "terminal_failure",
        errorCode: "RETRY_EXHAUSTED:PROVIDER_TIMEOUT",
      }),
    ]);
  });

  it("supersedes stale projection retries before calling the provider", async () => {
    const test = harness("timeout");
    const stale = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "projection:session:42:v1",
      triggerType: "projection.requested",
      channel: "airtable",
      recipientRef: "session:42",
      payload: { title: "Old" },
      projectionVersion: 1,
    });
    await test.worker.runOne();
    await test.service.retry(organizer, organizationId, stale.id);
    await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "projection:session:42:v2",
      triggerType: "projection.requested",
      channel: "airtable",
      recipientRef: "session:42",
      payload: { title: "New" },
      projectionVersion: 2,
    });
    await test.worker.runOne();
    expect(test.provider.calls).toHaveLength(1);
    expect(await test.repository.get(stale.id)).toMatchObject({ state: "terminal" });
    expect(await test.repository.attempts(stale.id)).toEqual([
      expect.objectContaining({ outcome: "retryable_failure" }),
      expect.objectContaining({ outcome: "terminal_failure", errorCode: "PROJECTION_SUPERSEDED" }),
    ]);
  });

  /**
   * The race the pre-call supersession guard cannot see, and the repair for it.
   *
   * The guard at the top of `runOne` reads the database before the provider call. A v2 enqueued
   * *during* v1's in-flight call therefore passes it, and both calls succeed — but they land at
   * the external system in the wrong order, so it keeps v1's data while the database correctly
   * records v2. Nothing about either delivery looks wrong afterwards: two successes, two
   * `succeeded` attempts, and a projection row naming the right version over stale remote data.
   *
   * `deliverOrder` below is the whole point: it is the external system's write order, and the
   * assertion is that v2 is written to it again *after* v1 overwrote it.
   */
  it("re-sends the newer projection when an overtaken one reaches the provider last", async () => {
    const test = harness();
    const deliverOrder: (number | null)[] = [];
    const telemetry: DeliveryAttemptRecord[] = [];
    const stale = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "projection:session:42:v1",
      triggerType: "projection.requested",
      channel: "airtable",
      recipientRef: "session:42",
      payload: { title: "Old" },
      projectionVersion: 1,
    });

    let overtaking: (() => Promise<void>) | null = async () => {
      const winner = await test.service.trigger(organizer, {
        organizationId,
        eventId,
        idempotencyKey: "projection:session:42:v2",
        triggerType: "projection.requested",
        channel: "airtable",
        recipientRef: "session:42",
        payload: { title: "New" },
        projectionVersion: 2,
      });
      // v1 is leased and mid-call, so this drains v2 and nothing else.
      await racing.runOne();
      expect(await test.repository.get(winner.id)).toMatchObject({ state: "succeeded" });
    };
    const provider: DeliveryProvider = {
      async deliver(delivery) {
        const interleave = overtaking;
        overtaking = null;
        if (interleave) await interleave();
        deliverOrder.push(delivery.projectionVersion);
        return { kind: "success", providerReference: `fake:${delivery.id}` };
      },
    };
    const racing = new OutboxWorker(
      test.repository,
      { email: provider, airtable: provider, accelevents: provider },
      { newId: () => `race-${deliverOrder.length}-${telemetry.length}`, now: () => new Date() },
      { attempt: (record) => telemetry.push(record) },
    );

    await racing.runOne();

    // v2 was written to the external system first and v1 overwrote it — the stale state this
    // whole mechanism exists to detect.
    expect(deliverOrder).toEqual([2, 1]);
    // The database was never wrong: the version guard refused v1's projection row.
    expect(test.repository.projections.get(`airtable:${eventId}:session:42`)).toMatchObject({
      version: 2,
    });
    expect(await test.repository.get(stale.id)).toMatchObject({ state: "succeeded" });
    // The repair: v2's delivery is queued again, so the winning payload is re-sent.
    const winner = await test.repository.findByIdempotencyKey(
      organizationId,
      "projection:session:42:v2",
    );
    expect(winner).toMatchObject({ state: "queued" });
    expect(telemetry.at(-1)).toMatchObject({ outcome: "succeeded", staleProjectionRepaired: true });

    await racing.runOne();
    // The external system now holds v2 again, and the re-send is the last word.
    expect(deliverOrder).toEqual([2, 1, 2]);
    // Re-sending an equal version is accepted, so the repair does not queue another repair.
    expect(telemetry.at(-1)).toMatchObject({ staleProjectionRepaired: false });
    expect(await racing.runOne()).toBe(false);
    expect(deliverOrder).toEqual([2, 1, 2]);
    // The re-send is an honest second attempt on the same delivery, not a rewritten first one.
    expect(await test.repository.attempts(winner?.id ?? "")).toEqual([
      expect.objectContaining({ sequence: 1, outcome: "succeeded" }),
      expect.objectContaining({ sequence: 2, outcome: "succeeded" }),
    ]);
  });

  /**
   * A newer version that failed terminally must not supersede an older one that can still be sent.
   *
   * Supersession means "a newer version has been sent or still will be". A terminal delivery will
   * never be sent, so counting it abandons the newest version anybody can still deliver — and it
   * is reachable exactly where it hurts most: it would strand the delivery the stale-projection
   * repair just re-queued, leaving the external system on the oldest payload with nothing left to
   * correct it.
   */
  it("does not let a terminally failed newer projection strand a deliverable older one", async () => {
    const test = harness();
    const deliverable = await test.service.trigger(organizer, {
      organizationId,
      eventId,
      idempotencyKey: "projection:session:88:v2",
      triggerType: "projection.requested",
      channel: "airtable",
      recipientRef: "session:88",
      payload: { title: "Deliverable" },
      projectionVersion: 2,
    });
    // v3 exhausted its retries and is terminal — written directly, because what is under test is
    // the guard's reading of that state rather than the path that produced it.
    await test.repository.enqueue({
      ...deliverable,
      id: "doomed-v3",
      idempotencyKey: "projection:session:88:v3",
      payload: { title: "Never arrives" },
      projectionVersion: 3,
      state: "terminal",
      attemptCount: 3,
    });

    // v2 is still the newest version anyone can deliver, so it is sent rather than superseded.
    await expect(test.repository.isProjectionSuperseded(deliverable)).resolves.toBe(false);
    await test.worker.runOne();
    expect(test.provider.calls.map(({ id }) => id)).toContain(deliverable.id);
    expect(test.repository.projections.get(`airtable:${eventId}:session:88`)).toMatchObject({
      version: 2,
    });
  });

  it("returns bounded cursor pages with attempts already grouped", async () => {
    const test = harness();
    await test.service.createTemplate(organizer, {
      organizationId,
      key: "digest",
      version: 1,
      channel: "email",
      subject: "Digest",
      body: "Update",
    });
    for (let index = 0; index < 30; index += 1)
      await test.service.trigger(organizer, {
        organizationId,
        eventId,
        idempotencyKey: `digest:${index}`,
        triggerType: "organizer.digest",
        channel: "email",
        recipientRef: `organizer:${index}`,
        payload: {},
        templateKey: "digest",
      });
    const first = await test.service.history(organizer, organizationId, eventId, { limit: 25 });
    expect(first.history).toHaveLength(25);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await test.service.history(organizer, organizationId, eventId, {
      limit: 25,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.history).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });

  it("does not mislabel unexpected recovery storage failures as conflicts", async () => {
    class FailingRetryRepository extends MemoryCommunicationsRepository {
      override async retry(): Promise<never> {
        throw new Error("storage unavailable");
      }
    }
    const repository = new FailingRetryRepository();
    await repository.enqueue({
      id: "terminal-storage",
      organizationId,
      eventId,
      idempotencyKey: "terminal-storage",
      triggerType: "projection.requested",
      channel: "airtable",
      templateId: null,
      templateVersion: null,
      recipientRef: "session:storage",
      payload: {},
      renderedSubject: null,
      renderedBody: null,
      projectionVersion: 1,
      state: "terminal",
      attemptCount: 1,
      nextAttemptAt: "2026-08-10T12:00:00.000Z",
      leaseToken: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });
    const service = new CommunicationsService({
      repository,
      eventDirectory: { belongsToOrganization: async () => true },
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    await expect(service.retry(organizer, organizationId, "terminal-storage")).rejects.toThrow(
      "storage unavailable",
    );
  });
});

/**
 * Composing to a chosen audience, and seeing what each of them will get (#189).
 *
 * The property that matters is that the preview and the send are the *same* resolution: a
 * preview a client rendered for itself could disagree with the message the delivery stores, and
 * would be believed because it looks like the message.
 */
describe("bulk speaker email", () => {
  const speakers = [
    { id: "user-ada", name: "Ada Rivera", email: "ada@example.test" },
    { id: "user-morgan", name: "Morgan Chen", email: "morgan@example.test" },
    // A real state the roster carries: identity holds no address, so this speaker is counted
    // and reported rather than guessed at.
    { id: "user-jordan", name: "Jordan Bell", email: null },
  ];

  const composing = () => {
    let id = 0;
    const repository = new MemoryCommunicationsRepository();
    const service = new CommunicationsService({
      repository,
      eventDirectory: {
        belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
          candidateEventId === eventId && candidateOrganizationId === organizationId,
        name: async () => "Greenroom Demo Summit",
      },
      speakerDirectory: { listSpeakersForEvent: async () => speakers },
      newId: () => `id-${++id}`,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    return { repository, service };
  };

  const publish = (service: CommunicationsService, key: string, body: string) =>
    service.createTemplate(organizer, {
      organizationId,
      key,
      channel: "email",
      subject: "{{eventName}}",
      body,
    });

  it("resolves each chosen recipient's own message, using every documented token", async () => {
    const { service } = composing();
    await publish(
      service,
      "bulk",
      "Hi {{speakerName}} at {{eventName}}, reply to {{speakerEmail}}.",
    );

    const { entries } = await service.previewBroadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "bulk",
    });

    // Only the reachable speakers, each with their own substitution.
    expect(entries.map(({ name }) => name)).toEqual(["Ada Rivera", "Morgan Chen"]);
    expect(entries[0]).toMatchObject({
      address: "ada@example.test",
      subject: "Greenroom Demo Summit",
      body: "Hi Ada Rivera at Greenroom Demo Summit, reply to ada@example.test.",
    });
    expect(entries[1]?.body).toContain("Morgan Chen");
    // Every token the vocabulary publishes is one the preview can actually fill; a documented
    // token the renderer could not resolve would be a template nobody can send.
    for (const { token } of SPEAKER_MERGE_FIELDS)
      expect(
        (
          await service.previewBroadcast(organizer, {
            organizationId,
            eventId,
            templateKey: (await publish(service, `only-${token}`, `{{${token}}}`)).key,
          })
        ).entries[0]?.body,
      ).not.toContain("{{");
  });

  /*
   * The defect this pins, found by driving the surface rather than reading it: the preview
   * answered 500 "Something went wrong" for an unfilled placeholder while the *send* answered
   * 400 naming the key — so the one screen built to tell an author what is wrong with their
   * template was the only one that could not.
   */
  it("refuses an unfilled placeholder the same way the send does, naming it", async () => {
    const { service } = composing();
    await publish(service, "hotel", "Hi {{speakerName}}, your hotel is {{hotelName}}.");
    const command = { organizationId, eventId, templateKey: "hotel" };

    await expect(service.previewBroadcast(organizer, command)).rejects.toThrow(/hotelName/);
    await expect(service.previewBroadcast(organizer, command)).rejects.toBeInstanceOf(
      CommunicationsInputError,
    );
    await expect(service.broadcast(organizer, command)).rejects.toBeInstanceOf(
      CommunicationsInputError,
    );
  });

  it("sends to the chosen speakers and nobody else", async () => {
    const { service } = composing();
    await publish(service, "bulk", "Hi {{speakerName}}.");

    const result = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "bulk",
      recipientIds: ["user-morgan"],
    });

    expect(result.enqueued).toBe(1);
    expect(result.deliveries.map(({ recipientRef }) => recipientRef)).toEqual([
      "morgan@example.test",
    ]);
    // The message stored on the delivery is the one the preview would have shown, which is what
    // makes the preview worth looking at.
    expect(result.deliveries[0]?.renderedBody).toBe("Hi Morgan Chen.");
    // Still reported, because an organizer sending to a selection still has to know who on the
    // roster can never be reached.
    expect(result.unreachable.map(({ name }) => name)).toEqual(["Jordan Bell"]);
  });

  it("refuses a chosen speaker who has left, or who has no address, and sends nothing", async () => {
    const { service, repository } = composing();
    await publish(service, "bulk", "Hi {{speakerName}}.");
    const command = { organizationId, eventId, templateKey: "bulk" };

    await expect(
      service.broadcast(organizer, { ...command, recipientIds: ["user-gone"] }),
    ).rejects.toBeInstanceOf(CommunicationsInputError);
    await expect(
      service.broadcast(organizer, { ...command, recipientIds: ["user-jordan"] }),
    ).rejects.toThrow(/no email address/);
    // "Nothing was sent" is part of both messages, so it had better be true.
    expect(await repository.list(organizationId, eventId)).toHaveLength(0);
  });

  it("keeps the preview and the send agreeing about who the audience is", async () => {
    const { service } = composing();
    await publish(service, "bulk", "Hi {{speakerName}}.");
    const chosen = { organizationId, eventId, templateKey: "bulk", recipientIds: ["user-ada"] };

    const preview = await service.previewBroadcast(organizer, chosen);
    const sent = await service.broadcast(organizer, {
      ...chosen,
      audienceVersion: preview.audienceVersion,
    });

    expect(sent.deliveries.map(({ renderedBody }) => renderedBody)).toEqual(
      preview.entries.map(({ body }) => body),
    );
    // And a confirmation taken against a roster that has since moved is refused rather than
    // reaching a different set of people than the one on screen.
    await expect(
      service.broadcast(organizer, { ...chosen, audienceVersion: "something-else" }),
    ).rejects.toThrow(/changed since you confirmed/);
  });

  /*
   * The other half of that agreement, and the #189 defect pointed the other way: the preview
   * dropped `payload` while the send rendered against it, so a template with a caller-supplied
   * placeholder previewed as "{{hotelName}} has no value" — telling the author their template
   * could not be sent — and then sent perfectly well. A preview that refuses what the send
   * delivers misleads exactly as badly as one that shows a message the delivery does not store.
   */
  it("keeps the preview and the send agreeing about what the message says", async () => {
    const { service } = composing();
    await publish(service, "hotel", "Hi {{speakerName}}, your hotel is {{hotelName}}.");
    // `hotelName` is in no merge-field vocabulary, so the renderer can fill it only from the
    // payload the caller supplied — which is the whole point of the field.
    const command = {
      organizationId,
      eventId,
      templateKey: "hotel",
      recipientIds: ["user-ada"],
      payload: { hotelName: "The Wren" },
    };

    const preview = await service.previewBroadcast(organizer, command);
    const sent = await service.broadcast(organizer, {
      ...command,
      audienceVersion: preview.audienceVersion,
    });

    expect(preview.entries[0]?.body).toBe("Hi Ada Rivera, your hotel is The Wren.");
    expect(sent.deliveries.map(({ renderedBody }) => renderedBody)).toEqual(
      preview.entries.map(({ body }) => body),
    );

    // And the per-recipient merge values still outrank a caller key of the same name, in the
    // preview exactly as on the delivery: one name shown for everybody while each delivery
    // stored its own recipient's would be the same disagreement wearing a different hat.
    await publish(service, "stage", "{{speakerName}} is on {{stageName}}.");
    const shadowed = {
      ...command,
      templateKey: "stage",
      payload: { stageName: "Main", speakerName: "Everybody" },
    };
    const shadowedPreview = await service.previewBroadcast(organizer, shadowed);
    const shadowedSend = await service.broadcast(organizer, shadowed);

    expect(shadowedPreview.entries[0]?.body).toBe("Ada Rivera is on Main.");
    expect(shadowedSend.deliveries.map(({ renderedBody }) => renderedBody)).toEqual(
      shadowedPreview.entries.map(({ body }) => body),
    );
  });
});
