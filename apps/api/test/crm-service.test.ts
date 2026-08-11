// @acceptance ACC-CRM
import { describe, expect, it, vi } from "vitest";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { CrmService } from "../src/application/crm/crm-service";
import { ProspectContactRequiredError } from "../src/application/crm/errors";
import {
  CapabilityDeniedError,
  type Actor,
  type Capability,
} from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(["crm:manage"]),
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["crm:manage"]) }],
};
const ids = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
];
const setup = () => {
  const repository = new MemoryCrmRepository();
  const createOrLink = vi
    .fn()
    .mockResolvedValue({ speakerId: "40000000-0000-4000-8000-000000000001" });
  const service = new CrmService({
    repository,
    speakerConversion: { createOrLink },
    newId: () => ids.shift() ?? crypto.randomUUID(),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { repository, service, createOrLink };
};

describe("ACC-CRM prospect lifecycle", () => {
  it("operates an event-scoped prospect with next actions, filters, and private history", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      nextAction: "Send invitation",
      nextActionAt: "2026-08-09T12:00:00.000Z",
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, {
      stage: "contacted",
      activity: { kind: "note", summary: "Private availability details", private: true },
    });
    expect(
      await service.list(organizer, eventId, {
        stage: "contacted",
        overdueBefore: "2026-08-10T12:00:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        name: "Ada Rivera",
        nextAction: "Send invitation",
        activities: [expect.objectContaining({ private: true })],
      }),
    ]);
    expect(() => service.list(organizer, otherEventId, {})).toThrow(CapabilityDeniedError);
  });

  it("converts idempotently through the content port and keeps private CRM data out of the command", async () => {
    const { service, createOrLink } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, {
      activity: { kind: "note", summary: "Do not publish", private: true },
    });
    const [first, second] = await Promise.all([
      service.convert(organizer, eventId, prospect.id, "conversion-correlation"),
      service.convert(organizer, eventId, prospect.id, "conversion-correlation"),
    ]);
    expect(first.speakerId).toBe(second.speakerId);
    expect(
      (await service.convert(organizer, eventId, prospect.id, "conversion-correlation")).speakerId,
    ).toBe(first.speakerId);
    expect(createOrLink).toHaveBeenCalledWith({
      eventId,
      source: { kind: "crm-prospect", id: prospect.id },
      name: "Ada Rivera",
      email: "ada@example.test",
      actorId: organizer.id,
      occurredAt: "2026-08-10T12:00:00.000Z",
      correlationId: "conversion-correlation",
      idempotencyKey: `crm-conversion:${eventId}:${prospect.id}`,
    });
    expect(JSON.stringify(createOrLink.mock.calls)).not.toContain("Do not publish");
    await expect(
      service.update(organizer, eventId, prospect.id, { stage: "contacted" }),
    ).rejects.toThrow("Converted prospects are immutable");
  });

  it("rejects unauthenticated, unauthorized, cross-event, and contactless conversion", async () => {
    const { repository, service } = setup();
    expect(() => service.list(null, eventId, {})).toThrow();
    const reviewer: Actor = { ...organizer, capabilities: new Set<Capability>() };
    expect(() => service.list(reviewer, eventId, {})).toThrow(CapabilityDeniedError);
    await repository.create({
      id: "50000000-0000-4000-8000-000000000001",
      eventId,
      name: "No Contact",
      stage: "identified",
      ownerId: organizer.id,
      nextAction: null,
      nextActionAt: null,
      contacts: [],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });
    await expect(
      service.convert(
        organizer,
        eventId,
        "50000000-0000-4000-8000-000000000001",
        "conversion-correlation",
      ),
    ).rejects.toBeInstanceOf(ProspectContactRequiredError);
  });
});
