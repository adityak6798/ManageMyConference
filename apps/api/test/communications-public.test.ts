// @acceptance ACC-INTEGRATION
// @spec PRD-COM-001 PRD-INT-001 ARC-FLOW-002
import { describe, expect, it } from "vitest";
import { preparedDeliveryWriter } from "../src/adapters/persistence/d1-communications-repository";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
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

const harness = () => {
  let id = 0;
  const repository = new MemoryCommunicationsRepository();
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
        candidateEventId === eventId && candidateOrganizationId === organizationId,
    },
    newId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { repository, service };
};

const seedTemplate = (service: CommunicationsService) =>
  service.createTemplate(organizer, {
    organizationId,
    key: "speaker-welcome",
    version: 1,
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
          run: async () => ({ success: true }),
          all: async () => ({ success: true, results: [] }),
        };
        return statement;
      },
      batch: async () => [{ success: true }],
    };

    const statements = preparedDeliveryWriter(database)(prepared);

    expect(statements).toHaveLength(1);
    expect(queries[0]).toContain("INSERT OR IGNORE INTO communication_deliveries");
    expect(bound[0]).toContain(prepared.idempotencyKey);
    expect(bound[0]).toContain(JSON.stringify(prepared.payload));
  });
});
