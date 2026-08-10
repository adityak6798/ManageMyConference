// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { type Actor, CapabilityDeniedError } from "../src/application/identity/actor";

const organizer = {
  id: "seed-organizer",
  persona: "organizer" as const,
  capabilities: new Set(["events:read" as const, "events:create" as const]),
};

describe("EventService", () => {
  it("persists a new event through its repository port", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    await service.create(organizer, { name: "Greenroom Summit", timezone: "America/Los_Angeles" });

    await expect(service.list(organizer)).resolves.toEqual([
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
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
    const reviewer: Actor = { id: "reviewer", persona: "reviewer", capabilities: new Set() };
    expect(() => service.list(reviewer)).toThrow(CapabilityDeniedError);
  });

  it("resets deterministic in-memory state", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    await service.create(organizer, { name: "Temporary", timezone: "UTC" });
    repository.reset();
    await expect(service.list(organizer)).resolves.toEqual([]);
  });
});
