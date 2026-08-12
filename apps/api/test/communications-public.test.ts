// @acceptance ACC-INTEGRATION
// @spec PRD-COM-001 PRD-INT-001 ARC-FLOW-002
import { describe, expect, it } from "vitest";
import { preparedDeliveryWriter } from "../src/adapters/persistence/d1-communications-repository";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { MAX_BROADCAST_RECIPIENTS } from "../src/application/communications/communications-service";
import {
  CommunicationsInputError,
  CommunicationsNotFoundError,
  CommunicationsService,
  type DeliveryRequest,
} from "../src/application/communications/public";
import type { Actor } from "../src/application/identity/actor";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["communications:manage"]) }],
  capabilities: new Set(["communications:manage"]),
};

const SPEAKERS = [
  { id: "user-ada", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "user-grace", name: "Grace Hopper", email: "grace@example.test" },
  { id: "user-unlinked", name: "Alan Turing", email: null },
];

const harness = (speakers: typeof SPEAKERS = SPEAKERS) => {
  let id = 0;
  const repository = new MemoryCommunicationsRepository();
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
        candidateEventId === eventId && candidateOrganizationId === organizationId,
    },
    speakerDirectory: { listSpeakersForEvent: async () => speakers },
    newId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { repository, service };
};

const seedTemplate = (service: CommunicationsService, version = 1) =>
  service.createTemplate(organizer, {
    organizationId,
    key: "speaker-welcome",
    version,
    channel: "email",
    subject: "You're speaking",
    body: "Hello {{speakerName}}",
  });

const request = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  organizationId,
  eventId,
  idempotencyKey: "speaker-welcome:session-1",
  triggerType: "speaker.invited",
  channel: "email",
  recipientRef: "speaker:profile-1",
  payload: { speakerName: "Ada" },
  templateKey: "speaker-welcome",
  ...overrides,
});

describe("communications public enqueue interface", () => {
  it("enqueues a lifecycle delivery with no actor at all", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const enqueued = await service.enqueue(request());

    expect(enqueued.state).toBe("queued");
    const [delivery] = await repository.list(organizationId, eventId);
    expect(delivery?.id).toBe(enqueued.id);
    expect(delivery?.recipientRef).toBe("speaker:profile-1");
    expect(delivery?.templateVersion).toBe(1);
  });

  it("converges on one delivery when the same lifecycle action runs twice", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const first = await service.enqueue(request());
    const second = await service.enqueue(request());

    expect(second.id).toBe(first.id);
    expect(await repository.list(organizationId, eventId)).toHaveLength(1);
  });

  it("refuses an event that belongs to another organization", async () => {
    const { service } = harness();
    await seedTemplate(service);

    await expect(service.enqueue(request({ eventId: "someone-elses-event" }))).rejects.toThrow(
      CommunicationsInputError,
    );
  });

  it("refuses a template version that does not exist", async () => {
    const { service } = harness();
    await seedTemplate(service);

    await expect(service.enqueue(request({ templateVersion: 7 }))).rejects.toThrow(
      CommunicationsNotFoundError,
    );
  });

  it("refuses an email delivery with no template, because there would be nothing to say", async () => {
    const { service } = harness();

    await expect(service.enqueue(request({ templateKey: undefined }))).rejects.toThrow(
      CommunicationsInputError,
    );
  });

  it("prepares a delivery without writing it, for a caller committing its own batch", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const prepared = await service.prepareEnqueue(
      request({ idempotencyKey: "schedule-published:event-1:3" }),
    );

    expect(prepared.state).toBe("queued");
    expect(prepared.templateVersion).toBe(1);
    expect(await repository.list(organizationId, eventId)).toHaveLength(0);

    // What the caller's batch would have written is exactly what enqueue writes.
    await repository.enqueue(prepared);
    expect(await repository.list(organizationId, eventId)).toHaveLength(1);
  });

  it("renders a prepared delivery into an idempotent insert the caller can batch", async () => {
    const { service } = harness();
    await seedTemplate(service);
    const prepared = await service.prepareEnqueue(request());
    const bound: unknown[][] = [];
    const queries: string[] = [];
    const database = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind(...values: unknown[]) {
            bound.push(values);
            return statement;
          },
          run: async () => ({ success: true, meta: { changes: 1 } }),
          all: async () => ({ success: true, results: [] }),
        };
        return statement;
      },
      batch: async () => [{ success: true, meta: { changes: 1 } }],
    };

    const statements = preparedDeliveryWriter(database)(prepared);

    expect(statements).toHaveLength(1);
    expect(queries[0]).toContain("INSERT INTO communication_deliveries");
    // Only the duplicate key is absorbed. `INSERT OR IGNORE` would also swallow a CHECK or
    // NOT NULL violation, and this statement is committed inside another domain's batch with
    // nothing reloading it afterwards — a silently dropped row there is a published schedule
    // with no delivery to announce it.
    expect(queries[0]).toContain("ON CONFLICT (organization_id, idempotency_key) DO NOTHING");
    expect(queries[0]).not.toContain("INSERT OR IGNORE");
    expect(bound[0]).toContain(prepared.idempotencyKey);
    expect(bound[0]).toContain(JSON.stringify(prepared.payload));
  });

  it("returns the delivery that already holds the key rather than an id nobody will write", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);
    const first = await service.prepareEnqueue(request());
    await repository.enqueue(first);

    const second = await service.prepareEnqueue(request());

    // The caller is going to store this id — in its own table, in an event payload. A retried
    // publish command must end up pointing at the delivery the first attempt created, because
    // its own insert will not write a second row for the same key.
    expect(second.id).toBe(first.id);
  });
});

describe("sending a template to an event's speakers", () => {
  it("gives every reachable speaker their own delivery and their own message", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const result = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(result.enqueued).toBe(2);
    const deliveries = await repository.list(organizationId, eventId);
    expect(deliveries.map((delivery) => delivery.recipientRef)).toEqual([
      "ada@example.test",
      "grace@example.test",
    ]);
    // One row per person, each addressed by name: "the send failed" is never true of an
    // audience, only of one address at a time.
    expect(deliveries.map((delivery) => delivery.renderedBody)).toEqual([
      "Hello Ada Lovelace",
      "Hello Grace Hopper",
    ]);
  });

  it("reports the speaker it cannot reach instead of quietly sending to fewer people", async () => {
    const { service } = harness();
    await seedTemplate(service);

    const result = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(result.unreachable).toEqual([
      { userId: "user-unlinked", name: "Alan Turing", address: null },
    ]);
  });

  it("does not mail anyone twice when Send is pressed twice", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const first = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });
    const second = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(await repository.list(organizationId, eventId)).toHaveLength(2);
    expect(second.deliveries.map(({ id }) => id)).toEqual(first.deliveries.map(({ id }) => id));
    // And it says so. Reporting `enqueued: 2` for a send that wrote nothing would promise mail
    // that will never go out — the organizer pressed Send precisely because they were unsure.
    expect(first).toMatchObject({ enqueued: 2, alreadySent: 0 });
    expect(second).toMatchObject({ enqueued: 0, alreadySent: 2 });
  });

  it("refuses an audience too large to send in one durable round trip", async () => {
    const crowd = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, index) => ({
      id: `user-${index}`,
      name: `Speaker ${index}`,
      email: `speaker${index}@example.test`,
    }));
    const { service, repository } = harness(crowd);
    await seedTemplate(service);

    await expect(
      service.broadcast(organizer, { organizationId, eventId, templateKey: "speaker-welcome" }),
    ).rejects.toThrow(CommunicationsInputError);
    // It fails before writing anything, rather than partway through with half the event queued
    // and the organizer told the send failed.
    expect(await repository.list(organizationId, eventId)).toHaveLength(0);
  });

  it("sends again for a new template version, which is how a wrong message is corrected", async () => {
    const { service, repository } = harness();
    await seedTemplate(service, 1);
    await service.broadcast(organizer, { organizationId, eventId, templateKey: "speaker-welcome" });

    await service.createTemplate(organizer, {
      organizationId,
      key: "speaker-welcome",
      version: 2,
      channel: "email",
      subject: "Correction",
      body: "Sorry {{speakerName}}, the previous note was wrong",
    });
    const corrected = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(corrected.enqueued).toBe(2);
    expect(await repository.list(organizationId, eventId)).toHaveLength(4);
    expect(corrected.deliveries[0]?.renderedSubject).toBe("Correction");
  });

  it("refuses a template that does not exist rather than sending nothing silently", async () => {
    const { service } = harness();

    await expect(
      service.broadcast(organizer, { organizationId, eventId, templateKey: "no-such-template" }),
    ).rejects.toThrow(CommunicationsNotFoundError);
  });

  it("lists every immutable version so an organizer can read what was sent", async () => {
    const { service } = harness();
    await seedTemplate(service, 1);
    await seedTemplate(service, 2);

    const templates = await service.templates(organizer, organizationId);

    expect(templates.map(({ version }) => version)).toEqual([2, 1]);
  });
});
