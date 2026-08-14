// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
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
  it("updates only an event carrying the settings capability", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const created = await service.create(organizer, {
      organizationId: organizer.organizations[0]?.id ?? "",
      idempotencyKey: "00000000-0000-4000-8000-000000000024",
      name: "Before",
      timezone: "UTC",
    });
    const editor: Actor = {
      ...organizer,
      eventAccess: [
        {
          eventId: created.id,
          role: "organizer",
          capabilities: new Set(["events:read", "events:settings:update"]),
        },
      ],
    };
    await expect(
      service.update(editor, created.id, { name: "After", timezone: "America/New_York" }),
    ).resolves.toMatchObject({ name: "After", timezone: "America/New_York" });

    const reviewer: Actor = {
      ...editor,
      persona: "reviewer",
      eventAccess: [
        { eventId: created.id, role: "reviewer", capabilities: new Set(["events:read"]) },
      ],
    };
    await expect(
      service.update(reviewer, created.id, { name: "Leaked", timezone: "UTC" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("persists a new event through its repository port", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    await service.create(organizer, {
      organizationId: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "00000000-0000-4000-8000-000000000063",
      name: "Greenroom Summit",
      timezone: "America/Los_Angeles",
    });
    // The role is part of the write that creates the event rather than a call after it, so an
    // event whose creator cannot open it is not a state this path can leave behind (issue #164).
    expect(repository.organizerGrants).toEqual([
      { eventId: "123e4567-e89b-12d3-a456-426614174000", userId: "seed-organizer" },
    ]);

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

  it("adopts a retried deliberate create and gives a new intent a new event", async () => {
    const repository = new MemoryEventRepository();
    let id = 0;
    const service = new EventService({
      repository,
      newId: () => `123e4567-e89b-42d3-a456-${String(++id).padStart(12, "0")}`,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    const command = {
      organizationId: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "00000000-0000-4000-8000-000000000070",
      name: "Additional Summit",
      timezone: "UTC",
    };

    const first = await service.create(organizer, command);
    const replay = await service.create(organizer, command);
    expect(replay.id).toBe(first.id);
    await expect(service.list(organizer)).resolves.toHaveLength(1);
    expect(repository.organizerGrants).toHaveLength(1);

    const second = await service.create(organizer, {
      ...command,
      idempotencyKey: "00000000-0000-4000-8000-000000000071",
    });
    expect(second.id).not.toBe(first.id);
    await expect(service.list(organizer)).resolves.toHaveLength(2);
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
      idempotencyKey: "00000000-0000-4000-8000-000000000109",
      name: "Temporary",
      timezone: "UTC",
    });
    repository.reset();
    await expect(service.list(organizer)).resolves.toEqual([]);
  });

  it("answers a bulk organization intersection through its public application query", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const inOrganization = {
      id: "123e4567-e89b-12d3-a456-426614174010",
      organizationId: organizer.organizations[0]?.id ?? "",
      name: "In organization",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    };
    const elsewhere = {
      ...inOrganization,
      id: "123e4567-e89b-12d3-a456-426614174020",
      organizationId: "00000000-0000-4000-8000-000000000020",
      name: "Elsewhere",
    };
    const alphabeticallyFirst = {
      ...inOrganization,
      id: "023e4567-e89b-12d3-a456-426614174010",
      name: "Also in organization",
    };
    await repository.create(inOrganization);
    await repository.create(elsewhere);
    await repository.create(alphabeticallyFirst);

    await expect(
      service.listEventIdsInOrganization(inOrganization.organizationId, [
        elsewhere.id,
        "missing",
        inOrganization.id,
        alphabeticallyFirst.id,
      ]),
    ).resolves.toEqual([alphabeticallyFirst.id, inOrganization.id]);
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
      idempotencyKey: "00000000-0000-4000-8000-000000000164",
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

  it("does not widen an API client's event allowlist through its tenant identity", async () => {
    const repository = new MemoryEventRepository();
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const allowedId = "123e4567-e89b-12d3-a456-426614174010";
    const deniedId = "123e4567-e89b-12d3-a456-426614174020";
    for (const [id, name] of [
      [allowedId, "Allowed"],
      [deniedId, "Not allowlisted"],
    ] as const)
      await repository.create({
        id,
        organizationId: organizer.organizations[0]?.id ?? "",
        name,
        timezone: "UTC",
        createdAt: "2026-08-13T12:00:00.000Z",
      });
    const client: Actor = {
      ...organizer,
      id: "api-client",
      eventAccess: [
        {
          eventId: allowedId,
          role: "organizer",
          capabilities: new Set(["events:read"]),
        },
      ],
      capabilities: new Set(["events:read"]),
      organizationAccess: [{ id: organizer.organizations[0]?.id ?? "", capabilities: new Set() }],
      roleGrantSubjectId: "seed-organizer",
    };

    await expect(service.list(client)).resolves.toMatchObject([{ id: allowedId }]);
    await expect(service.get(client, deniedId)).resolves.toBeNull();
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
        idempotencyKey: "00000000-0000-4000-8000-000000000227",
        name: "Leaked",
        timezone: "UTC",
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
