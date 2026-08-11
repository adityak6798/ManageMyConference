// @acceptance ACC-HARNESS
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { type Actor, CapabilityDeniedError } from "../src/application/identity/actor";

const organizer = {
  id: "seed-organizer",
  name: "Olivia Organizer",
  persona: "organizer" as const,
  organizations: [{ id: "00000000-0000-4000-8000-000000000010", name: "Greenroom Labs" }],
  eventAccess: [],
  capabilities: new Set(["events:read" as const, "events:create" as const]),
};

describe("EventService", () => {
  it("persists a new event through its repository port", async () => {
    const repository = new MemoryEventRepository();
    const grantOrganizer = vi.fn().mockResolvedValue(undefined);
    const service = new EventService({
      repository,
      newId: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      grantOrganizer,
    });

    await service.create(organizer, {
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "Greenroom Summit",
      timezone: "America/Los_Angeles",
    });
    expect(grantOrganizer).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      "seed-organizer",
    );

    await expect(service.list(organizer)).resolves.toEqual([
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Greenroom Summit",
        timezone: "America/Los_Angeles",
        createdAt: "2026-08-09T12:00:00.000Z",
      },
    ]);
  });

  it("enforces capabilities inside the application layer", async () => {
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const reviewer: Actor = {
      id: "reviewer",
      name: "Reviewer",
      persona: "reviewer",
      organizations: [],
      eventAccess: [],
      capabilities: new Set(),
    };
    expect(() => service.list(reviewer)).toThrow(CapabilityDeniedError);
  });

  it("resets deterministic in-memory state", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    await service.create(organizer, {
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "Temporary",
      timezone: "UTC",
    });
    repository.reset();
    await expect(service.list(organizer)).resolves.toEqual([]);
  });

  it("never exposes an event outside the actor's organization or event assignment", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    await service.create(organizer, {
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "Visible",
      timezone: "UTC",
    });
    const outsider: Actor = {
      id: "outsider",
      name: "Outside Reviewer",
      persona: "reviewer",
      organizations: [],
      eventAccess: [],
      capabilities: new Set(["events:read"]),
    };
    await expect(service.list(outsider)).resolves.toEqual([]);
    await expect(service.get(outsider, "123e4567-e89b-12d3-a456-426614174000")).resolves.toBeNull();
  });

  it("denies creation in an organization the organizer does not belong to", async () => {
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    await expect(
      service.create(organizer, {
        organizationId: "00000000-0000-4000-8000-000000000099",
        name: "Leaked",
        timezone: "UTC",
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
