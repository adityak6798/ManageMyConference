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
            [
              { id: "20000000-0000-4000-8000-000000000001", title: "Opening", speakerIds: [] },
              {
                id: "20000000-0000-4000-8000-000000000002",
                title: "Accessible by default",
                speakerIds: [],
              },
            ],
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
      {
        id: "20000000-0000-4000-8000-000000000002",
        title: "Accessible by default",
        speakerIds: [],
      },
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
    // The watermark has to roll back with them. A publication that left the count advanced would
    // flag a sound event forever; one that left the claim advanced would hide a real divergence.
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 1,
      materialized_watermark: 1,
    });
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
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 1,
      materialized_watermark: 1,
    });
  });

  /**
   * The steady-state read costs the same whatever the history, which is what #141 bought.
   *
   * It is now two statements rather than one — the rows, and the watermark that says whether they
   * can be believed — and both are in one `batch`, so it is still one round trip and still
   * independent of how many boards the event has published. What it must never do is read
   * `agenda_publications`: a check that replayed would have given the cost straight back.
   *
   * The second half is the other side of that bargain. Twelve publications written *directly*, as
   * the deploy window writes them, and the very next read notices and replays. That read is
   * expensive precisely once, and the read after it is two statements again.
   */
  it("reads the revisions without touching the history, until the history moves without them", async () => {
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
    const withOnePublication = [...prepared];

    await insertHistory(
      migrated.database,
      Array.from({ length: 12 }, (_, index) =>
        publication(index + 2, board([at("place-a", sessionA, mainStage.id, slot1000.id)])),
      ),
    );

    prepared = [];
    const repaired = await repository.sessionScheduleRevisions(eventId);
    const whileDrifted = [...prepared];

    prepared = [];
    await repository.sessionScheduleRevisions(eventId);

    expect(withOnePublication).toHaveLength(2);
    expect(withOnePublication.some((query) => query.includes("agenda_publications"))).toBe(false);
    // The drifted read replays; the answer it returns is the fold's, not the stale table's.
    expect(whileDrifted.some((query) => query.includes("agenda_publications"))).toBe(true);
    expect(repaired).toEqual(await foldStoredHistory(migrated.database));
    // Thirteen publications, back to two statements — which is the whole point of storing this.
    expect(prepared).toHaveLength(2);
    expect(prepared.some((query) => query.includes("agenda_publications"))).toBe(false);
  });

  /**
   * Drift detection and repair (issue #169, closing `GAP-024`).
   *
   * Every case here reaches a state no supported code path produces, by writing
   * `agenda_publications` the way the old Worker does during a deploy: directly, with nothing
   * maintaining the derived table. That is the point — the invariant #141 relied on was
   * convention, and these prove that breaking it is now *noticed* rather than merely possible.
   */
  const watermarks = async (database: {
    prepare(query: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
  }) =>
    (
      await database
        .prepare(
          "SELECT publication_watermark, materialized_watermark FROM agenda_schedule_materializations WHERE event_id = ?",
        )
        .bind(eventId)
        .all<{ publication_watermark: number; materialized_watermark: number | null }>()
    ).results?.[0];

  it("leaves the seeded fixture sound, so drift means something", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-seed", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    // The seed writes publications directly, so `1602`'s trigger creates its row — and the seed
    // claims the watermark itself, because it does maintain the derived table.
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 1,
      materialized_watermark: 1,
    });
    expect(await repository.driftedEvents(10)).toEqual([]);
    const report = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(report.drift).toEqual({ missing: [], phantom: [], divergent: [] });
    expect(report.repaired).toBe(false);
  });

  /**
   * The phantom row: the case that sends mail nobody should receive.
   *
   * A publication that unplaces the session makes a correct table drop its row, so a Send skips
   * it. A stale table keeps the row, and nothing downstream re-checks it against the board in
   * force, so the session still reads as scheduled at the hour it used to hold and the speakers
   * are mailed an invitation to a session the programme does not schedule.
   */
  it("detects a publication written behind its back, and repairs the phantom row it leaves", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-phantom", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    await insertHistory(migrated.database, [publication(2, board([]))]);

    // The trigger fires for a writer that knows nothing about the derived table, which is the
    // only reason this is detectable at all.
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 2,
      materialized_watermark: 1,
    });
    expect(await repository.driftedEvents(10)).toEqual([eventId]);
    expect((await repository.reconcileSessionSchedules(eventId, { repair: false })).drift).toEqual({
      missing: [],
      phantom: [sessionA, sessionB],
      divergent: [],
    });
    // Still stale: a read-only check is a question, not an action.
    const stale = await storedRevisions(migrated.database);
    expect([...stale.keys()]).toEqual([sessionA, sessionB]);
    expect(stale.get(sessionA)).toMatchObject({
      startsAt: slot0900.startsAt,
      endsAt: slot0900.endsAt,
      location: mainStage.name,
      revision: 1,
    });

    // Nothing had to be asked. Reading the schedule is what repairs it.
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual([]);
    expect(await storedRevisions(migrated.database)).toEqual(new Map());
    expect(await repository.driftedEvents(10)).toEqual([]);
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 2,
      materialized_watermark: 2,
    });
  });

  /**
   * The stale revision: the case that withholds mail somebody should receive.
   *
   * Session A is invited at version 1 with ref `1|…`. A missed publication unplaces it. Version 3
   * places it back at the identical hour, through the repository this time. Absence resets, so the
   * replay says revision 3 and the REQUEST that puts the talk back on the speaker's calendar goes
   * out. Folding version 3 over the stale version 1 row would compute "unchanged", keep revision
   * 1, match the ref already in `calendar_invite_states`, and send nothing — verbatim the
   * regression issue #136 exists to prevent.
   */
  it("does not fold a missed publication through into the next one", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-suppress", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    await insertHistory(migrated.database, [publication(2, board([]))]);
    expect(
      await repository.publish(
        publication(3, board([at("place-a", sessionA, mainStage.id, slot0900.id)])),
      ),
    ).toBe("committed");

    expect((await repository.sessionScheduleRevisions(eventId)).get(sessionA)).toEqual({
      startsAt: slot0900.startsAt,
      endsAt: slot0900.endsAt,
      location: mainStage.name,
      revision: 3,
      revisedAt: "2026-08-12T00:00:03.000Z",
    });
    expect(await storedRevisions(migrated.database)).toEqual(
      await foldStoredHistory(migrated.database),
    );
    expect(await repository.driftedEvents(10)).toEqual([]);
  });

  /**
   * A derived table edited directly leaves the watermark undisturbed, which is exactly why the
   * on-demand reconciliation replays instead of trusting it.
   *
   * The cheap check can only ever notice that the *history* moved. This is the divergence it
   * cannot see, and the surface that exists to find it.
   */
  it("finds a divergence the watermark cannot see, and only the replay does", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-edited", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    await migrated.database
      .prepare(
        "UPDATE agenda_session_schedules SET starts_at = ?, location = ? WHERE event_id = ? AND session_id = ?",
      )
      .bind(slot1000.startsAt, workshopLab.name, eventId, sessionA)
      .run();

    // The watermark still says "current", because nothing wrote the history.
    expect(await repository.driftedEvents(10)).toEqual([]);
    expect((await repository.sessionScheduleRevisions(eventId)).get(sessionA)?.startsAt).toBe(
      slot1000.startsAt,
    );

    const found = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(found.drift.divergent).toHaveLength(1);
    expect(found.drift.divergent[0]?.stored.location).toBe(workshopLab.name);
    expect(found.drift.divergent[0]?.replayed.location).toBe(mainStage.name);
    expect(found.repaired).toBe(false);

    const repaired = await repository.reconcileSessionSchedules(eventId, { repair: true });
    expect(repaired.repaired).toBe(true);
    expect(await storedRevisions(migrated.database)).toEqual(
      await foldStoredHistory(migrated.database),
    );
  });

  /**
   * `1602` will not claim that `1601` caught everything, and the first repair is what settles it.
   *
   * Two migrations run in sequence against a live database, and a publication can land between
   * them — the deploy window is open while they run. So the backfill marks every already-published
   * event as never derived, and the sweep replays each one exactly once. Reconstructed here by
   * dropping the table and re-applying the migration, which is the state a deployed database is in
   * the moment `1602` finishes.
   */
  it("treats an event backfilled by 1602 as unverified until something verifies it", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-backfill", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());
    // More than one publication, so `COUNT(*)` in the backfill is distinguishable from a constant.
    await insertHistory(migrated.database, [
      publication(2, board([at("place-a", sessionA, mainStage.id, slot0900.id)])),
      publication(3, board([at("place-a", sessionA, mainStage.id, slot0900.id)])),
    ]);
    await repository.sessionScheduleRevisions(eventId);
    const before = await storedRevisions(migrated.database);

    // Its triggers hang off `agenda_publications`, so dropping the table alone leaves them
    // behind and re-applying the migration fails on the first `CREATE TRIGGER`.
    for (const object of [
      "TABLE agenda_schedule_materializations",
      "TRIGGER agenda_publication_insert_advances_watermark",
      "TRIGGER agenda_publication_delete_invalidates_watermark",
    ])
      await migrated.database.prepare(`DROP ${object}`).run();
    await applyMigrationFile(migrated.database, "1602_agenda_schedule_materializations.sql");

    // Three publications written, so the counter starts at three: it counts writes, and `COUNT(*)`
    // is what a migration can know about writes that happened before it existed.
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 3,
      materialized_watermark: null,
    });
    expect(await repository.driftedEvents(10)).toEqual([eventId]);

    // The rows were right all along; what the repair adds is a table that says so.
    const report = await repository.reconcileSessionSchedules(eventId, { repair: true });
    expect(report.drift).toEqual({ missing: [], phantom: [], divergent: [] });
    expect(report.repaired).toBe(true);
    expect(await storedRevisions(migrated.database)).toEqual(before);
    expect(await repository.driftedEvents(10)).toEqual([]);
  });

  /**
   * A history that *shrank* invalidates the fold as surely as one that grew.
   *
   * Not a path this system takes — publications are immutable and only the seed reset removes
   * them — but the invariant is "the derived table reflects the history", and the delete trigger
   * is what keeps that true rather than merely usually true.
   */
  it("re-derives after a publication is deleted", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-deleted", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    await migrated.database
      .prepare("DELETE FROM agenda_publications WHERE event_id = ? AND version = 1")
      .bind(eventId)
      .run();

    const invalidated = await watermarks(migrated.database);
    expect(invalidated?.materialized_watermark).toBeNull();
    /*
     * The counter moves too, and that half is the one easy to leave out. Clearing the claim alone
     * would let a repair that read the watermark *before* the delete still match afterwards,
     * writing rows that include the deleted snapshot and erasing this very invalidation.
     */
    expect(invalidated?.publication_watermark).toBe(2);
    expect(await repository.driftedEvents(10)).toEqual([eventId]);
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual([]);
    expect(await repository.driftedEvents(10)).toEqual([]);
  });

  /**
   * The `missing` axis: a row deleted straight out of the derived table.
   *
   * The other direction of the drift the on-demand replay exists for. It leaves the watermark
   * undisturbed, so no cheap check can see it, and every consumer reads the session as "not
   * scheduled yet" — the speaker calendar send skips it without adding it to `unreachable`, so the
   * organizer is shown zero invitations and zero problems. Worth its own case rather than being
   * folded into the phantom one: the repair's affected-row count is read from the *claim*, and a
   * `DELETE` that legitimately removes nothing is exactly how reading it from the wrong statement
   * would go unnoticed.
   */
  it("repairs a row deleted straight out of the derived table", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-missing", seed: true });
    runtime = migrated.runtime;
    const repairs: string[] = [];
    const repository = new D1AgendaRepository(
      migrated.database,
      () => new Date(),
      undefined,
      (report) => repairs.push(`${report.eventId}:${report.drift.missing.length}`),
    );
    const before = await storedRevisions(migrated.database);

    await migrated.database
      .prepare("DELETE FROM agenda_session_schedules WHERE event_id = ?")
      .bind(eventId)
      .run();

    // The watermark never moved, so nothing flags it and the read serves the empty table.
    expect(await repository.driftedEvents(10)).toEqual([]);
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual([]);

    const report = await repository.reconcileSessionSchedules(eventId, { repair: true });
    expect(report.drift.missing).toEqual([sessionA, sessionB]);
    expect(report.repaired).toBe(true);
    expect(repairs).toEqual([`${eventId}:2`]);
    expect(await storedRevisions(migrated.database)).toEqual(before);
  });

  /**
   * A failed statement inside the batched read is an error, not an empty answer.
   *
   * The two reads share one `batch`, and D1 reports each statement's outcome separately — so a
   * failure on the watermark arrives as `success: false` on that entry rather than as a rejected
   * promise. Reading `results` without checking would turn it into "this event has never
   * published", which is the one wrong answer that silences drift detection entirely.
   */
  it("refuses a batched read whose statement failed, rather than reading it as empty", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-readfail", seed: true });
    runtime = migrated.runtime;
    const failing = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        const results = (await (
          migrated.database as unknown as { batch(s: unknown[]): Promise<unknown[]> }
        ).batch(statements)) as Array<Record<string, unknown>>;
        // The watermark statement, reported as having failed.
        return results.map((result, index) =>
          index === 1 ? { ...result, success: false, error: "no such table" } : result,
        );
      },
    };
    const repository = new D1AgendaRepository(
      failing as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    await expect(repository.sessionScheduleRevisions(eventId)).rejects.toThrow(
      /failed to read the schedule watermark/,
    );
  });

  /**
   * The one affected-row count in this adapter that is load-bearing, refused when it is absent.
   *
   * The claim "these rows describe every publication up to version N" is conditional on the
   * watermark not having moved, and a driver that omits `meta.changes` makes "matched" and "did
   * not match" indistinguishable. Guessing "matched" would mark a partial replay as current and
   * silence the detector permanently; guessing "did not match" would retry a repair that
   * succeeded. Neither is available, so the call fails and says which count it wanted.
   *
   * The write itself may well have landed — this is a driver that under-reports, not one that
   * refused — and that is precisely why the answer cannot be inferred from anything else here.
   */
  /**
   * A history longer than one replay page (`REPLAY_PAGE = 25`).
   *
   * Every other case here is a handful of publications, so the paging loop's boundary was never
   * reached and a one-character mutation of its terminator — `<` to `<=` — returned after the
   * first page and left the whole suite green. In production that repairs an event to the fold of
   * its first twenty-five publications and then *claims the watermark for it*: a permanently wrong
   * table that reports itself sound. Unbounded history is the subject of #141 and #169, so the one
   * loop that walks it needs its boundary pinned.
   */
  it("replays a history longer than one page", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-paged", seed: true });
    runtime = migrated.runtime;
    const repository = new D1AgendaRepository(migrated.database, () => new Date());

    // 26 more publications on top of the seed's, so the last page is a partial one and the
    // session's final placement is decided well past the first page boundary.
    await insertHistory(
      migrated.database,
      Array.from({ length: 26 }, (_, index) =>
        publication(
          index + 2,
          board([
            at("place-a", sessionA, index === 25 ? workshopLab.id : mainStage.id, slot1000.id),
          ]),
        ),
      ),
    );

    const repaired = await repository.sessionScheduleRevisions(eventId);
    expect(repaired).toEqual(await foldStoredHistory(migrated.database));
    // The last publication is the one that moved it, and it is only reachable on the second page.
    expect(repaired.get(sessionA)).toEqual({
      startsAt: slot1000.startsAt,
      endsAt: slot1000.endsAt,
      location: workshopLab.name,
      revision: 27,
      revisedAt: "2026-08-12T00:00:27.000Z",
    });
    expect(
      (await repository.reconcileSessionSchedules(eventId, { repair: false })).publications,
    ).toBe(27);
    expect(await repository.driftedEvents(10)).toEqual([]);
  });

  /**
   * A repair that loses its race writes **nothing**, and says so.
   *
   * This is the interleaving the guard exists for, and an earlier version of this adapter got it
   * wrong: it rewrote the rows unconditionally and conditioned only the watermark claim. A D1
   * batch is one transaction, but a zero-row `UPDATE` does not abort it — so the losing attempt
   * committed a stale prefix of the history underneath a watermark the winning publication had
   * already marked current, which is the undetectable divergence the whole mechanism exists to
   * prevent, manufactured by the repair path itself.
   *
   * Driven by writing a publication in the window between the replay and the batch, which is
   * exactly where a real one lands. The first attempt must leave the table untouched; the retry
   * must converge on the full history.
   */
  it("writes nothing when the history moves during the replay, then converges", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-race", seed: true });
    runtime = migrated.runtime;
    const seededRows = await storedRevisions(migrated.database);

    let racesLeft = 1;
    const racing = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        // One publication lands after the replay finished and before its write commits.
        if (racesLeft > 0) {
          racesLeft -= 1;
          await insertHistory(migrated.database, [
            publication(3, board([at("place-b", sessionB, workshopLab.id, slot1000.id)])),
          ]);
        }
        return (migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
          statements,
        );
      },
    };
    const repository = new D1AgendaRepository(
      racing as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    await insertHistory(migrated.database, [publication(2, board([]))]);
    const revisions = await repository.sessionScheduleRevisions(eventId);

    // The retry saw all three publications: A unplaced at 2, B placed at 3.
    expect(revisions).toEqual(await foldStoredHistory(migrated.database));
    expect([...revisions.keys()]).toEqual([sessionB]);
    expect(await storedRevisions(migrated.database)).toEqual(revisions);
    expect(await repository.driftedEvents(10)).toEqual([]);
    // The seeded row was never replaced by the losing attempt's answer, only by the winning one.
    expect(seededRows.get(sessionA)).toBeDefined();
  });

  /**
   * The losing attempt is what the affected-row count reports, and the count decides.
   *
   * With the guard on every statement, a claim that matched nothing means the rows were not
   * written either. Reading that count as "applied" — the mutation `=== 1` to `>= 0` — would
   * report a repair that did not happen and mark the event sound. The race above already exercises
   * the branch; this pins the *decision*, by racing every attempt and asserting the call reports
   * no repair rather than a false one.
   *
   * The racing publications **place** a session rather than clearing the board, and that detail is
   * load-bearing rather than incidental: a replay that produced no rows would run no inserts, so a
   * guard dropped from the insert statements would survive this test. It is dropped from all of
   * them together or from none.
   */
  it("reports no repair when every attempt loses, and leaves the rows alone", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-lost", seed: true });
    runtime = migrated.runtime;

    let version = 2;
    const alwaysRacing = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        version += 1;
        await insertHistory(migrated.database, [
          publication(version, board([at("place-b", sessionB, workshopLab.id, slot1000.id)])),
        ]);
        return (migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
          statements,
        );
      },
    };
    const repository = new D1AgendaRepository(
      alwaysRacing as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    // A drifted event whose replay yields a row to insert as well as one to delete.
    await insertHistory(migrated.database, [
      publication(2, board([at("place-b", sessionB, workshopLab.id, slot1000.id)])),
    ]);
    const before = await storedRevisions(migrated.database);
    expect([...before.keys()]).toEqual([sessionA, sessionB]);

    const report = await repository.reconcileSessionSchedules(eventId, { repair: true });
    expect(report.repaired).toBe(false);
    expect(report.inSync).toBe(false);
    // Untouched: no delete, no insert, no claim. A losing repair is a no-op, not a partial write.
    expect(await storedRevisions(migrated.database)).toEqual(before);
    expect(await repository.driftedEvents(10)).toEqual([eventId]);
  });

  /**
   * A committed publication claims the watermark, and the claim is conditional.
   *
   * Two properties, both of which survived mutation until this existed. The counter has to reach
   * exactly the number of writes the history has taken — binding the read value instead of
   * `read + 1` leaves every published event permanently flagged, so every read replays and the
   * tick never stops, which is the cost #141 removed reinstated by a silent off-by-one. And the
   * claim has to *fail* when somebody else wrote in between: `AgendaService.publish` is defended
   * by the version primary key, but a writer that does not allocate `max + 1` collides with
   * nothing, and marking the event caught up would fold that publication out of existence.
   */
  it("claims the watermark on a committed publication, and only when nothing else wrote", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-claim", seed: true });
    runtime = migrated.runtime;

    const quiet = new D1AgendaRepository(migrated.database, () => new Date());
    expect(
      await quiet.publish(
        publication(2, board([at("place-a", sessionA, mainStage.id, slot1000.id)])),
      ),
    ).toBe("committed");
    // Two writes: the seed's publication and this one.
    expect(await watermarks(migrated.database)).toEqual({
      publication_watermark: 2,
      materialized_watermark: 2,
    });
    expect(await quiet.driftedEvents(10)).toEqual([]);

    /*
     * Now a writer that allocates its own version lands between the read and the write. Injected
     * *after* the first batch returns, because that first batch is `readMaterialized` — which is
     * precisely the read the claim is conditional on.
     */
    let injected = false;
    const interleaved = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        const result = await (
          migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }
        ).batch(statements);
        if (!injected) {
          injected = true;
          await insertHistory(migrated.database, [publication(50, board([]))]);
        }
        return result;
      },
    };
    const raced = new D1AgendaRepository(
      interleaved as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );
    expect(
      await raced.publish(
        publication(3, board([at("place-a", sessionA, mainStage.id, slot0900.id)])),
      ),
    ).toBe("committed");

    // The publication committed; the claim did not, so the event is flagged rather than sound.
    const after = await watermarks(migrated.database);
    expect(after?.publication_watermark).toBe(4);
    expect(after?.materialized_watermark).toBe(2);
    expect(await raced.driftedEvents(10)).toEqual([eventId]);
  });

  /**
   * When every attempt loses, the answer served is the replayed one — never the rows it just
   * proved stale.
   *
   * An earlier revision returned the stored rows here while the comment above it claimed the
   * opposite, which handed the calendar-invite read the phantom row it had detected in the same
   * call. `drift.phantom` being non-empty in the report and the phantom row being absent from the
   * answer is the pair that has to hold.
   */
  it("serves the replayed answer when it cannot record it", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-served", seed: true });
    runtime = migrated.runtime;

    let version = 2;
    const alwaysRacing = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        version += 1;
        await insertHistory(migrated.database, [
          publication(version, board([at("place-b", sessionB, workshopLab.id, slot1000.id)])),
        ]);
        return (migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
          statements,
        );
      },
    };
    const repository = new D1AgendaRepository(
      alwaysRacing as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    await insertHistory(migrated.database, [
      publication(2, board([at("place-b", sessionB, workshopLab.id, slot1000.id)])),
    ]);
    // The stored table still holds both seeded sessions; version 2 retains only session B.
    expect([...(await storedRevisions(migrated.database)).keys()]).toEqual([sessionA, sessionB]);

    const served = await repository.sessionScheduleRevisions(eventId);
    // The phantom row is not in the answer, even though nothing could be written.
    expect([...served.keys()]).toEqual([sessionB]);
    expect(await storedRevisions(migrated.database)).not.toEqual(served);
    expect(await repository.driftedEvents(10)).toEqual([eventId]);
  });

  /** Every repair reaches the observer, including the ones a read performs. */
  it("reports a read-path repair to the observer, not only a swept one", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-observed", seed: true });
    runtime = migrated.runtime;
    const repairs: string[] = [];
    const repository = new D1AgendaRepository(
      migrated.database,
      () => new Date(),
      undefined,
      (report) => repairs.push(`${report.eventId}:${report.drift.phantom.length}`),
    );

    await insertHistory(migrated.database, [publication(2, board([]))]);
    await repository.sessionScheduleRevisions(eventId);

    expect(repairs).toEqual([`${eventId}:2`]);
    // And not again once it is sound, so the line means something when it appears.
    await repository.sessionScheduleRevisions(eventId);
    expect(repairs).toHaveLength(1);
  });

  /**
   * And a repair that did not happen is not reported as one.
   *
   * The observer's whole value is that its appearance means something. Firing it for an attempt
   * that wrote nothing would turn "a recurring line names a writer that needs fixing" into noise
   * generated by ordinary contention.
   */
  it("does not report a repair that wrote nothing", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-unreported", seed: true });
    runtime = migrated.runtime;
    const repairs: string[] = [];

    let version = 2;
    const alwaysRacing = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        version += 1;
        await insertHistory(migrated.database, [publication(version, board([]))]);
        return (migrated.database as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
          statements,
        );
      },
    };
    const repository = new D1AgendaRepository(
      alwaysRacing as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
      undefined,
      (report) => repairs.push(report.eventId),
    );

    await insertHistory(migrated.database, [publication(2, board([]))]);
    expect((await repository.reconcileSessionSchedules(eventId, { repair: true })).repaired).toBe(
      false,
    );
    expect(repairs).toEqual([]);
  });

  it("refuses to claim the watermark when the driver reports no row count", async () => {
    const migrated = await createMigratedDatabase({ label: "agenda-drift-nocount", seed: true });
    runtime = migrated.runtime;
    const countless = {
      prepare: (query: string) => migrated.database.prepare(query),
      batch: async (statements: unknown[]) => {
        const results = (await (
          migrated.database as unknown as { batch(s: unknown[]): Promise<unknown[]> }
        ).batch(statements)) as Array<Record<string, unknown>>;
        return results.map(({ meta: _dropped, ...rest }) => rest);
      },
    };
    const repository = new D1AgendaRepository(
      countless as unknown as ConstructorParameters<typeof D1AgendaRepository>[0],
      () => new Date(),
    );

    await insertHistory(migrated.database, [publication(2, board([]))]);
    await expect(repository.sessionScheduleRevisions(eventId)).rejects.toThrow(
      /reported no row count while attempting to claim the agenda schedule watermark/,
    );
  });
});
