// @acceptance ACC-AGENDA
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import type { Actor } from "../src/application/identity/actor";
import {
  type AgendaDraft,
  conflictsFor,
  nextSessionScheduleRevisions,
  type SessionScheduleRevision,
} from "../src/domain/agenda/agenda";
import { applyMigrationFile, createMigratedDatabase } from "./support/seeded-d1";

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

  it("advances board occurrences with the write, against the revision that won", async () => {
    /*
     * Driven against real D1 because the occurrences are folded *inside* the compare-and-set loop
     * (issue #180): a lost update has to re-fold against the board that actually committed, and
     * that is the one property an in-memory double cannot show. Two concurrent placements of two
     * different sessions therefore end up with two different numbers, never one number written
     * twice.
     */
    const migrated = await createMigratedDatabase({ label: "agenda-occurrences", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());
    const eventId = "00000000-0000-4000-8000-000000000001";
    const seeded = await repository.getDraft(eventId);
    if (!seeded) throw new Error("Agenda fixture is required");
    /*
     * The seeded row was written before the occurrences existed and no migration backfilled it,
     * which is the shape every board in a deployed database has on the day this lands. The read
     * normalizes rather than leaving the field absent, because the response contract now requires
     * it and `savePlacements` answers with the board it read when a plan seats nothing.
     */
    expect(seeded.occurrences).toEqual({ sessions: {}, slots: {} });
    const cell = { roomId: "room-lab", trackId: "track-practice", slotId: "slot-1000" };

    await Promise.all([
      repository.savePlacement(eventId, { id: "occ-a", sessionId: "session-workshop", ...cell }),
      repository.savePlacement(eventId, {
        id: "occ-b",
        sessionId: "session-keynote",
        ...cell,
        slotId: "slot-0900",
      }),
    ]);
    const placed = await repository.getDraft(eventId);
    const workshop = placed?.occurrences?.sessions["session-workshop"] ?? 0;
    const keynote = placed?.occurrences?.sessions["session-keynote"] ?? 0;
    expect(workshop).toBeGreaterThan(0);
    expect(keynote).toBeGreaterThan(0);
    expect(workshop).not.toEqual(keynote);

    await repository.removePlacement(eventId, "occ-a");
    const removed = await repository.getDraft(eventId);
    // Unplacing is a new occurrence of "not on the board", and the session that was not touched
    // keeps the number it had.
    expect(removed?.occurrences?.sessions["session-workshop"]).toBeGreaterThan(workshop);
    expect(removed?.occurrences?.sessions["session-keynote"]).toBe(keynote);
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

/**
 * The materialized per-session revisions (issue #141).
 *
 * `revision` and `revisedAt` are not internal bookkeeping: #136 writes them into
 * `calendar_invite_states.schedule_ref`, so a revision that differs from what the replay this
 * change removes would have produced resends an invitation to every speaker already holding
 * one. That is why the backfill is tested against the rule itself rather than against a table
 * of expected numbers — a fixture can be wrong in the same direction as the SQL, and a second
 * implementation of the fold cannot.
 */
describe("D1AgendaRepository session schedule revisions", () => {
  let runtime: Miniflare | undefined;
  // Cleared as well as disposed, so a case that starts no runtime does not dispose the previous
  // case's a second time — which reports as "Server is not running" against the wrong test.
  afterEach(async () => {
    const started = runtime;
    runtime = undefined;
    await started?.dispose();
  });

  const eventId = "00000000-0000-4000-8000-000000000001";
  const sessionA = "20000000-0000-4000-8000-000000000001";
  const sessionB = "20000000-0000-4000-8000-000000000002";
  const mainStage = { id: "room-main", name: "Main stage" };
  const workshopLab = { id: "room-lab", name: "Workshop lab" };
  const slot0900 = {
    id: "slot-0900",
    startsAt: "2026-09-01T16:00:00.000Z",
    endsAt: "2026-09-01T17:00:00.000Z",
  };
  /** The same hour as `slot-0900` under a different id, so a move to it is not a revision. */
  const slot0900Twin = { ...slot0900, id: "slot-0900-twin" };
  const slot1000 = {
    id: "slot-1000",
    startsAt: "2026-09-01T17:00:00.000Z",
    endsAt: "2026-09-01T18:00:00.000Z",
  };

  const at = (id: string, sessionId: string, roomId: string, slotId: string) => ({
    id,
    sessionId,
    roomId,
    trackId: "track-platform",
    slotId,
  });
  const board = (
    placements: AgendaDraft["placements"],
    overrides: Partial<AgendaDraft> = {},
  ): AgendaDraft => ({
    eventId,
    rooms: [mainStage, workshopLab],
    tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
    slots: [slot0900, slot0900Twin, slot1000],
    sessions: [],
    placements,
    ...overrides,
  });

  const publication = (version: number, agenda: AgendaDraft): PublishedSchedule => ({
    eventId,
    version,
    publishedAt: `2026-08-12T00:00:${String(version).padStart(2, "0")}.000Z`,
    publishedBy: "seed-organizer",
    agenda,
  });

  /** Insert straight into `agenda_publications`, bypassing the repository, as the seed does. */
  const insertHistory = async (
    database: {
      prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
    },
    history: readonly PublishedSchedule[],
  ) => {
    for (const entry of history)
      await database
        .prepare(
          "INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          entry.eventId,
          entry.version,
          entry.publishedAt,
          entry.publishedBy,
          JSON.stringify(entry.agenda),
        )
        .run();
  };

  const storedRevisions = async (database: {
    prepare(query: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
  }) => {
    const rows = await database
      .prepare(
        "SELECT session_id, starts_at, ends_at, location, revision, revised_at FROM agenda_session_schedules WHERE event_id = ? ORDER BY session_id",
      )
      .bind(eventId)
      .all<{
        session_id: string;
        starts_at: string;
        ends_at: string;
        location: string;
        revision: number;
        revised_at: string;
      }>();
    return new Map<string, SessionScheduleRevision>(
      (rows.results ?? []).map((row) => [
        row.session_id,
        {
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          location: row.location,
          revision: row.revision,
          revisedAt: row.revised_at,
        },
      ]),
    );
  };

  /** Fold the rule over whatever `agenda_publications` actually holds, oldest first. */
  const foldStoredHistory = async (database: {
    prepare(query: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
  }) => {
    const rows = await database
      .prepare(
        "SELECT version, published_at, schedule_json FROM agenda_publications WHERE event_id = ? ORDER BY version",
      )
      .bind(eventId)
      .all<{ version: number; published_at: string; schedule_json: string }>();
    let revisions: ReadonlyMap<string, SessionScheduleRevision> = new Map();
    for (const row of rows.results ?? [])
      revisions = nextSessionScheduleRevisions(revisions, {
        version: row.version,
        publishedAt: row.published_at,
        agenda: JSON.parse(row.schedule_json) as AgendaDraft,
      });
    return revisions;
  };

  /**
   * The backfill reproduces the replay it replaces, over a history that exercises every branch.
   *
   * The seed has already published version 1 (session A on the main stage at 09:00). Versions 2
   * to 12 add, in order: an unchanged republication, a published empty board, an identical
   * return after that absence, a second session appearing, a snapshot whose placement names a
   * slot it no longer holds, that session's return, a move to a different slot at the same
   * hour, a snapshot with the room removed, the room's restoration, a session placed twice, and
   * a final snapshot that drops a room.
   *
   * The last two are deliberately last. A history that only ever *recovers* from a removed room
   * computes the empty location without ever materializing it, and a `COALESCE` dropped from
   * the room lookup then survives the whole suite; ending on the removal is what makes the
   * location column carry it. Likewise the double placement at 11 is in two **non-overlapping**
   * slots, which `conflictsFor` does not treat as a `SESSION_OVERLAP` — so it is a board that
   * really can be published, and the last-in-array-wins ordering really is load-bearing rather
   * than defensive.
   *
   * Dropping the table first reconstructs exactly the state a deployed database is in when
   * `1601` runs: the history is populated and the table does not exist yet.
   */
  it("backfills exactly what folding the rule over the same history produces", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-backfill", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;

    const aAt0900 = at("place-a", sessionA, mainStage.id, slot0900.id);
    const bAt1000 = at("place-b", sessionB, workshopLab.id, slot1000.id);
    await insertHistory(database, [
      publication(2, board([aAt0900])),
      publication(3, board([])),
      publication(4, board([aAt0900])),
      publication(5, board([aAt0900, bAt1000])),
      publication(6, board([at("place-a", sessionA, mainStage.id, "slot-removed"), bAt1000])),
      publication(7, board([aAt0900, bAt1000])),
      publication(8, board([at("place-a2", sessionA, mainStage.id, slot0900Twin.id), bAt1000])),
      publication(
        9,
        board([at("place-a2", sessionA, mainStage.id, slot0900Twin.id), bAt1000], {
          rooms: [mainStage],
        }),
      ),
      publication(10, board([at("place-a2", sessionA, mainStage.id, slot0900Twin.id), bAt1000])),
      // B twice, in slots that do not overlap in time and rooms that do not clash: a board with
      // no conflicts at all, so publication would accept it. The later placement wins.
      publication(
        11,
        board([
          at("place-a2", sessionA, mainStage.id, slot0900Twin.id),
          bAt1000,
          at("place-b-dup", sessionB, workshopLab.id, slot0900.id),
        ]),
      ),
      // Ends on a removed room, so the empty location is what the table actually holds.
      publication(
        12,
        board(
          [
            at("place-a2", sessionA, mainStage.id, slot0900Twin.id),
            bAt1000,
            at("place-b-dup", sessionB, workshopLab.id, slot0900.id),
          ],
          { rooms: [mainStage] },
        ),
      ),
    ]);

    await database.prepare("DROP TABLE agenda_session_schedules").run();
    await applyMigrationFile(database, "1601_agenda_session_schedules.sql");

    const backfilled = await storedRevisions(database);
    expect(backfilled).toEqual(await foldStoredHistory(database));
    // Spelled out as well, so a fold that silently agreed on nothing could not pass. A last
    // changed when it returned at 7 and has not moved since. B took its *second* placement's
    // 09:00 slot at 11, then lost its room at 12.
    expect(backfilled.get(sessionA)).toEqual({
      startsAt: slot0900.startsAt,
      endsAt: slot0900.endsAt,
      location: mainStage.name,
      revision: 7,
      revisedAt: "2026-08-12T00:00:07.000Z",
    });
    expect(backfilled.get(sessionB)).toEqual({
      startsAt: slot0900.startsAt,
      endsAt: slot0900.endsAt,
      location: "",
      revision: 12,
      revisedAt: "2026-08-12T00:00:12.000Z",
    });
  });

  /**
   * The board at version 11 above is one publication would really accept.
   *
   * Asserted rather than assumed, because the whole reason `placement_index DESC` is load-bearing
   * is that `conflictsFor` reaches its `SESSION_OVERLAP` branch only for placements whose slots
   * overlap in time. If that ever stopped being true, the double-placement case above would
   * become unreachable history and the ordering it pins would be untested rather than wrong.
   */
  it("treats a session placed twice in non-overlapping slots as publishable", () => {
    const twiceInNonOverlappingSlots = board([
      at("place-a2", sessionA, mainStage.id, slot0900Twin.id),
      at("place-b", sessionB, workshopLab.id, slot1000.id),
      at("place-b-dup", sessionB, workshopLab.id, slot0900.id),
    ]);

    expect(
      conflictsFor({
        ...twiceInNonOverlappingSlots,
        // Both schedulable and sharing no speaker, so the only conflict that could arise is the
        // `SESSION_OVERLAP` this case exists to show does not arise.
        sessions: [
          { id: sessionA, title: "Opening", speakerIds: [] },
          { id: sessionB, title: "Deep dive", speakerIds: [] },
        ],
      }),
    ).toEqual([]);
  });

  it("advances only the sessions a publication actually moved", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-advance", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    // The seed placed session A at 09:00 on the main stage in version 1.
    const seeded = await repository.sessionScheduleRevisions(eventId);
    expect(seeded.get(sessionA)?.revision).toBe(1);

    // Version 2 leaves A exactly where it was and introduces B.
    expect(
      await repository.publish(
        publication(
          2,
          board([
            at("place-a", sessionA, mainStage.id, slot0900.id),
            at("place-b", sessionB, workshopLab.id, slot1000.id),
          ]),
        ),
      ),
    ).toBe("committed");

    const advanced = await repository.sessionScheduleRevisions(eventId);
    expect(advanced.get(sessionA)).toEqual(seeded.get(sessionA));
    expect(advanced.get(sessionB)?.revision).toBe(2);
    expect(advanced.get(sessionB)?.revisedAt).toBe("2026-08-12T00:00:02.000Z");
  });

  it("leaves the revisions untouched when the publication's batch fails", async () => {
    const migrated = await createMigratedDatabase({
      label: "agenda-materialize-rollback",
      seed: true,
    });
    runtime = migrated.runtime;
    // The same failing event writer the rollback case above uses: the statement names a column
    // that does not exist, so the batch is refused after the materialization statements ran.
    const repository = new D1AgendaRepository(
      migrated.database,
      () => new Date(),
      (db) => [db.prepare("INSERT INTO nonexistent_publication_events (id) VALUES (1)")],
    );
    const before = await storedRevisions(migrated.database);

    await expect(
      repository.publish(
        publication(2, board([at("place-a", sessionA, workshopLab.id, slot1000.id)])),
      ),
    ).rejects.toThrow();

    // The materialization shares the snapshot's fate: neither the publication nor the moved
    // revision it would have written survives.
    expect(await storedRevisions(migrated.database)).toEqual(before);
  });

  it("writes nothing when the version was already taken", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-taken", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());
    const before = await storedRevisions(migrated.database);

    // Version 1 is the seed's. A refused allocation must not leave this board's revisions
    // behind, or the retry at the next version would compare against a snapshot nobody has.
    expect(
      await repository.publish(
        publication(1, board([at("place-a", sessionA, workshopLab.id, slot1000.id)])),
      ),
    ).toBe("version-taken");

    expect(await storedRevisions(migrated.database)).toEqual(before);
  });

  it("reads the revisions with one statement, whatever the length of the history", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-read-cost", seed: true });
    runtime = migrated.runtime;
    let prepared: string[] = [];
    const counting = {
      prepare: (query: string) => {
        prepared.push(query);
        return migrated.database.prepare(query);
      },
      batch: (statements: unknown[]) =>
        (migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
          statements,
        ),
    };
    const repository = new D1AgendaRepository(
      counting as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    prepared = [];
    await repository.sessionScheduleRevisions(eventId);
    const withOnePublication = prepared.length;

    await insertHistory(
      migrated.database,
      Array.from({ length: 12 }, (_, index) =>
        publication(index + 2, board([at("place-a", sessionA, mainStage.id, slot0900.id)])),
      ),
    );

    prepared = [];
    await repository.sessionScheduleRevisions(eventId);

    expect(withOnePublication).toBe(1);
    // Thirteen publications, still one statement — which is the whole point of storing this.
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toContain("agenda_session_schedules");
    expect(prepared[0]).not.toContain("agenda_publications");
  });
});
