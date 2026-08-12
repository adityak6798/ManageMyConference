// @acceptance ACC-AGENDA
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import type { Actor } from "../src/application/identity/actor";
import { conflictsFor } from "../src/domain/agenda/agenda";
import { createMigratedDatabase } from "./support/seeded-d1";

const organizer: Actor = {
  id: "seed-organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: "org" }],
  capabilities: new Set(["agenda:manage"]),
  eventAccess: [
    {
      eventId: "00000000-0000-4000-8000-000000000001",
      role: "organizer",
      capabilities: new Set(["agenda:manage"]),
    },
  ],
};

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

/**
 * Publication is the one agenda write that must be atomic across two facts: the immutable
 * snapshot, and the event telling the rest of the system it exists. These drive real D1 because
 * the properties under test — primary-key contention and batch rollback — are exactly the ones
 * an in-memory double would have to fake.
 */
describe("D1AgendaRepository publication transaction", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  const eventId = "00000000-0000-4000-8000-000000000001";
  const snapshot = (version: number): PublishedSchedule => ({
    eventId,
    version,
    publishedAt: "2026-08-11T10:00:00.000Z",
    publishedBy: "seed-organizer",
    agenda: {
      eventId,
      rooms: [{ id: "room-main", name: "Main stage" }],
      tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
      slots: [
        {
          id: "slot-0900",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
        },
      ],
      sessions: [{ id: "20000000-0000-4000-8000-000000000001", title: "Opening", speakerIds: [] }],
      placements: [
        {
          id: "placement-opening",
          sessionId: "20000000-0000-4000-8000-000000000001",
          roomId: "room-main",
          trackId: "track-platform",
          slotId: "slot-0900",
        },
      ],
    },
  });

  /** A scratch stand-in for whichever domain durably records events; see `DEBT-006`. */
  const createEventSink = async (database: {
    prepare(query: string): { run(): Promise<unknown> };
  }) => {
    await database
      .prepare(
        "CREATE TABLE test_publication_events (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, publication_version INTEGER NOT NULL, payload_json TEXT NOT NULL)",
      )
      .run();
  };

  it("refuses a version another publication already took, without throwing", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-publish", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    // The seed already published version 1, so taking it again must be refused rather than
    // overwriting the snapshot that is currently public.
    expect(await repository.publish(snapshot(1))).toBe("version-taken");
    expect(await repository.publish(snapshot(2))).toBe("committed");

    const published = await repository.getPublished(eventId);
    expect(published?.version).toBe(2);
  });

  it("commits the publication and its event in one batch", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-emit", seed: true });
    runtime = migrated.runtime;
    await createEventSink(migrated.database);
    const repository = new D1AgendaRepository(
      migrated.database,
      () => new Date(),
      (db, event) => [
        db
          .prepare(
            "INSERT OR IGNORE INTO test_publication_events (id, event_id, publication_version, payload_json) VALUES (?, ?, ?, ?)",
          )
          .bind(event.id, event.eventId, event.publicationVersion, JSON.stringify(event)),
      ],
    );

    expect(await repository.publish(snapshot(2))).toBe("committed");

    const events = await migrated.database
      .prepare("SELECT id, publication_version FROM test_publication_events")
      .all<{ id: string; publication_version: number }>();
    expect(events.results).toEqual([
      { id: `EVT-SCHEDULE-PUBLISHED:${eventId}:2`, publication_version: 2 },
    ]);
  });

  it("leaves neither a publication nor an event when the event write fails", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-rollback", seed: true });
    runtime = migrated.runtime;
    await createEventSink(migrated.database);
    // The event statement names a column that does not exist, which is how a real emission
    // fails: the outbox rejects the row after the publication statement has already run.
    const repository = new D1AgendaRepository(
      migrated.database,
      () => new Date(),
      (db) => [db.prepare("INSERT INTO test_publication_events (nonexistent_column) VALUES (1)")],
    );

    await expect(repository.publish(snapshot(2))).rejects.toThrow();

    // Version 2 must not exist: the publication statement ran first inside the same batch, so
    // only a genuine rollback keeps it out.
    const rows = await migrated.database
      .prepare("SELECT version FROM agenda_publications WHERE event_id = ? ORDER BY version")
      .bind(eventId)
      .all<{ version: number }>();
    expect(rows.results?.map((row: { version: number }) => row.version)).toEqual([1]);
    const events = await migrated.database
      .prepare("SELECT id FROM test_publication_events")
      .all<{ id: string }>();
    expect(events.results ?? []).toEqual([]);
  });

  it("gives concurrent publications distinct, increasing versions", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-versions", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-11T10:00:00.000Z"),
      new FixtureSchedulableContentQuery(
        new Map([
          [
            eventId,
            [{ id: "20000000-0000-4000-8000-000000000001", title: "Opening", speakerIds: [] }],
          ],
        ]),
      ),
    );

    const published = await Promise.all([
      service.publish(organizer, eventId),
      service.publish(organizer, eventId),
      service.publish(organizer, eventId),
    ]);

    // Three attempts, three durable publications: none lost, none sharing a number. The seed
    // holds version 1, so the allocation loop must have walked past it and past each other.
    const versions = published.map(({ version }) => version).sort((a, b) => a - b);
    expect(versions).toEqual([2, 3, 4]);

    const rows = await migrated.database
      .prepare("SELECT version FROM agenda_publications WHERE event_id = ? ORDER BY version")
      .bind(eventId)
      .all<{ version: number }>();
    expect(rows.results?.map((row: { version: number }) => row.version)).toEqual([1, 2, 3, 4]);
  });

  /**
   * The assisted pass plans inside the compare-and-set, so a placement that commits between the
   * request's read and its write is already on the board when cells are chosen.
   *
   * Driven against real D1 because the property under test is what the optimistic revision does
   * when it loses: an in-memory double would have to fake the losing attempt.
   */
  it("refuses a replayed command key, and keeps unkeyed publications independent", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-idempotent", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    expect(await repository.publish({ ...snapshot(2), commandKey: "cmd-1" })).toBe("committed");
    // Same key, next version: the partial unique index refuses it, and the refusal must read
    // as a replay rather than as a taken version, or the caller would retry it forever.
    expect(await repository.publish({ ...snapshot(3), commandKey: "cmd-1" })).toBe(
      "command-replayed",
    );
    expect((await repository.findByCommandKey(eventId, "cmd-1"))?.version).toBe(2);

    // Two publications with no key must not collide with each other: NULLs are not duplicates.
    expect(await repository.publish(snapshot(3))).toBe("committed");
    expect(await repository.publish(snapshot(4))).toBe("committed");
    expect((await repository.getPublished(eventId))?.version).toBe(4);
  });

  it("plans against the revision it writes, so a concurrent placement cannot be overlapped", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-replan", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());
    const sessions = [
      { id: "20000000-0000-4000-8000-000000000001", title: "Opening", speakerIds: [] },
      { id: "rival-session", title: "Rival", speakerIds: [] },
    ];
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-11T10:00:00.000Z"),
      new FixtureSchedulableContentQuery(new Map([[eventId, sessions]])),
    );
    await repository.removePlacement(eventId, "placement-opening");

    // An assisted pass and a hand placement race for the board's free cells.
    const [assisted] = await Promise.all([
      service.autoPlace(organizer, eventId),
      repository.savePlacement(eventId, {
        id: "rival",
        sessionId: "rival-session",
        roomId: "room-main",
        trackId: "track-platform",
        slotId: "slot-0900",
      }),
    ]);

    // Whichever order they land in, the board that results holds both and clashes in neither:
    // the plan was computed against the revision it actually wrote.
    const final = await repository.getDraft(eventId);
    if (!final) throw new Error("Agenda fixture is required");
    expect(final.placements.map(({ id }) => id)).toContain("rival");
    expect(conflictsFor({ ...final, sessions })).toEqual([]);
    expect(assisted.conflicts).toEqual([]);
  });
});
