// @acceptance ACC-AGENDA
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import { createMigratedDatabase } from "./support/seeded-d1";

describe("D1AgendaRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("retries concurrent placement writes without losing either update", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-concurrency", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1AgendaRepository(database, () => new Date("2026-08-10T22:00:00.000Z"));
    const eventId = "00000000-0000-4000-8000-000000000001";
    await Promise.all([
      repository.savePlacement(eventId, {
        id: "placement-concurrent-a",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-0900",
      }),
      repository.savePlacement(eventId, {
        id: "placement-concurrent-b",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-1000",
      }),
    ]);
    const ids = (await repository.getDraft(eventId))?.placements.map(({ id }) => id) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining(["placement-concurrent-a", "placement-concurrent-b"]),
    );
    const current = await repository.getDraft(eventId);
    if (!current) throw new Error("Agenda fixture is required");
    await Promise.all([
      repository.saveResources(eventId, {
        rooms: [...current.rooms, { id: "room-concurrent", name: "Concurrent room" }],
        tracks: current.tracks,
        slots: current.slots,
      }),
      repository.savePlacement(eventId, {
        id: "placement-concurrent-c",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-1000",
      }),
    ]);
    const afterResourceWrite = await repository.getDraft(eventId);
    expect(afterResourceWrite?.rooms).toContainEqual({
      id: "room-concurrent",
      name: "Concurrent room",
    });
    expect(afterResourceWrite?.placements.map(({ id }) => id)).toContain("placement-concurrent-c");
  });
});
