// @acceptance ACC-CRM
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CrmRepository } from "../src/adapters/persistence/d1-crm-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import {
  ContactAlreadySourcedError,
  ContactEmailTakenError,
  ContactNotFoundError,
  PipelineStageInUseError,
  PipelineStageNotFoundError,
} from "../src/application/crm/errors";
import { applyMigrationFile, createMigratedDatabase } from "./support/seeded-d1";

const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";

/**
 * Every migration, then the deterministic seed. The CRM's guarantees are written in the
 * schema — foreign keys, the partial conversion index, batch atomicity — so they can only be
 * proved against the real applied schema.
 */
const migratedRuntime = (label: string) => createMigratedDatabase({ label, seed: true });

describe("D1 CRM persistence", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("atomically records one conversion activity under concurrency", async () => {
    const migrated = await migratedRuntime("crm-test");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const prospect = {
      id: "10000000-0000-4000-8000-000000000010",
      eventId,
      name: "Concurrent",
      stage: "contacted" as const,
      ownerId: "seed-organizer",
      nextAction: null,
      nextActionAt: null,
      contacts: [
        {
          id: "20000000-0000-4000-8000-000000000010",
          name: "Concurrent",
          email: "concurrent@example.test",
          isPrimary: true,
        },
      ],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    await repository.create(prospect);
    const activity = (id: string) => ({
      id,
      kind: "conversion" as const,
      summary: "Converted prospect to speaker",
      private: false,
      occurredAt: "2026-08-10T12:00:00.000Z",
      actorId: "seed-organizer",
    });
    const existingSpeakerId = "10000000-0000-4000-8000-000000000001";
    await database
      .prepare(
        "CREATE TRIGGER fail_conversion_activity BEFORE INSERT ON crm_activities WHEN NEW.kind='conversion' BEGIN SELECT RAISE(FAIL, 'injected audit failure'); END",
      )
      .run();
    await expect(
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000009"),
      ),
    ).rejects.toThrow();
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      speakerId: null,
      stage: "contacted",
    });
    await database.prepare("DROP TRIGGER fail_conversion_activity").run();
    const converted = await Promise.all([
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000010"),
      ),
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000011"),
      ),
    ]);
    expect(converted.map(({ speakerId }) => speakerId)).toEqual([
      existingSpeakerId,
      existingSpeakerId,
    ]);
    const activities = await database
      .prepare("SELECT id FROM crm_activities WHERE prospect_id=? AND kind='conversion'")
      .bind(prospect.id)
      .all();
    expect(activities.results).toHaveLength(1);
    const persisted = await repository.findById(eventId, prospect.id);
    if (!persisted) throw new Error("Converted prospect was not persisted");
    await expect(repository.update({ ...persisted, stage: "contacted" })).rejects.toThrow();
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "converted",
      speakerId: existingSpeakerId,
    });
  });

  it("writes one stage transition when two conversions race, not one per attempt", async () => {
    const migrated = await migratedRuntime("crm-conversion-history-race");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The conversion's history entry was a bare INSERT sitting beside a row-guarded UPDATE, so
     * two organizers pressing Convert at the same instant moved the card once, recorded one
     * conversion activity — the partial index sees to that — and left *two* transition rows. The
     * history then reported a move the losing organizer never made, on a board that shows one.
     */
    const prospect = {
      id: "10000000-0000-4000-8000-000000000040",
      eventId,
      name: "Raced to Convert",
      stage: "contacted" as const,
      ownerId: "seed-organizer",
      nextAction: null,
      nextActionAt: null,
      contacts: [],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    await repository.create(prospect);
    const speakerId = "10000000-0000-4000-8000-000000000001";
    const occurredAt = "2026-08-12T12:30:00.000Z";
    const attempt = (suffix: string) =>
      repository.recordConversion(
        eventId,
        prospect.id,
        speakerId,
        {
          id: `30000000-0000-4000-8000-0000000000${suffix}`,
          kind: "conversion" as const,
          summary: "Converted prospect to speaker",
          private: false,
          occurredAt,
          actorId: "seed-organizer",
        },
        {
          id: `55000000-0000-4000-8000-0000000000${suffix}`,
          eventId,
          prospectId: prospect.id,
          fromStage: "contacted",
          toStage: "converted",
          actorId: "seed-organizer",
          source: "conversion" as const,
          occurredAt,
        },
      );
    await Promise.all([attempt("40"), attempt("41")]);

    const history = await database
      .prepare(
        "SELECT id, from_stage, to_stage, source FROM crm_prospect_transitions WHERE prospect_id=?",
      )
      .bind(prospect.id)
      .all<{
        id: string;
        from_stage: string | null;
        to_stage: string;
        source: string;
      }>();
    expect(history.results).toHaveLength(1);
    expect(history.results?.[0]).toMatchObject({
      from_stage: "contacted",
      to_stage: "converted",
      source: "conversion",
    });
    // The entry that survived is the one whose conversion applied, so the card and its history
    // agree about what happened to it.
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "converted",
      speakerId,
    });
  });

  it("writes a stage transition and its note in one batch, or neither of them", async () => {
    const migrated = await migratedRuntime("crm-stage-history");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const prospect = {
      id: "10000000-0000-4000-8000-000000000020",
      eventId,
      name: "Tracked",
      stage: "identified" as const,
      ownerId: "seed-organizer",
      nextAction: null,
      nextActionAt: null,
      contacts: [],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    await repository.create(prospect);
    const note = {
      id: "30000000-0000-4000-8000-000000000021",
      kind: "note" as const,
      summary: "Left a voicemail",
      private: true,
      occurredAt: "2026-08-10T12:05:00.000Z",
      actorId: "seed-organizer",
    };
    await repository.update(
      {
        ...prospect,
        stage: "contacted",
        updatedAt: "2026-08-10T12:05:00.000Z",
        activities: [note],
      },
      [note],
      undefined,
      {
        toStage: "contacted",
        actorId: "seed-organizer",
        source: "detail",
        occurredAt: "2026-08-10T12:05:00.000Z",
      },
    );
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "contacted",
      activities: [
        { kind: "stage-change", summary: "Identified → Contacted", private: false },
        { kind: "note", summary: "Left a voicemail", private: true },
      ],
    });

    // A note the database refuses takes the transition down with it: the timeline can never
    // claim a stage the row does not hold.
    await database
      .prepare(
        "CREATE TRIGGER fail_note_activity BEFORE INSERT ON crm_activities WHEN NEW.kind='note' BEGIN SELECT RAISE(FAIL, 'injected note failure'); END",
      )
      .run();
    await expect(
      repository.update(
        {
          ...prospect,
          stage: "engaged",
          updatedAt: "2026-08-10T12:10:00.000Z",
          activities: [],
        },
        [{ ...note, id: "30000000-0000-4000-8000-000000000023" }],
        undefined,
        {
          toStage: "engaged",
          actorId: "seed-organizer",
          source: "detail",
          occurredAt: "2026-08-10T12:10:00.000Z",
        },
      ),
    ).rejects.toThrow();
    await database.prepare("DROP TRIGGER fail_note_activity").run();
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "contacted",
      activities: [{ kind: "stage-change" }, { kind: "note" }],
    });
    const transitions = await database
      .prepare("SELECT id FROM crm_activities WHERE prospect_id=? AND kind='stage-change'")
      .bind(prospect.id)
      .all();
    expect(transitions.results).toHaveLength(1);
  });

  it("records the stage each interleaved move actually left", async () => {
    const migrated = await migratedRuntime("crm-stage-history-race");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const prospect = cardIn("10000000-0000-4000-8000-000000000025", "Moved twice", "identified");
    await repository.create(prospect);

    // Both organizers read Identified before either write. The second command deliberately
    // carries that stale prospect snapshot; only the repository's write-time row is current.
    const stale = await repository.findById(eventId, prospect.id);
    if (!stale) throw new Error("The race fixture is missing");
    await repository.update(
      { ...stale, stage: "contacted", updatedAt: "2026-08-10T12:05:00.000Z" },
      [],
      undefined,
      {
        toStage: "contacted",
        actorId: "seed-organizer",
        source: "board",
        occurredAt: "2026-08-10T12:05:00.000Z",
      },
    );
    await repository.update(
      { ...stale, stage: "engaged", updatedAt: "2026-08-10T12:06:00.000Z" },
      [],
      undefined,
      {
        toStage: "engaged",
        actorId: "seed-reviewer",
        source: "board",
        occurredAt: "2026-08-10T12:06:00.000Z",
      },
    );

    const rows = await database
      .prepare(
        "SELECT from_stage, to_stage, actor_id FROM crm_prospect_transitions WHERE prospect_id=? ORDER BY occurred_at",
      )
      .bind(prospect.id)
      .all<{ from_stage: string; to_stage: string; actor_id: string }>();
    expect(rows.results).toEqual([
      { from_stage: "identified", to_stage: "contacted", actor_id: "seed-organizer" },
      { from_stage: "contacted", to_stage: "engaged", actor_id: "seed-reviewer" },
    ]);
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "engaged",
      activities: [{ summary: "Identified → Contacted" }, { summary: "Contacted → Engaged" }],
    });
  });

  /** A history row as the stage-delete tests read it back, straight out of the table. */
  interface HistoryRow {
    id: string;
    prospect_id: string;
    from_stage: string | null;
    to_stage: string;
    actor_id: string;
    source: string;
  }

  /**
   * A prospect on the seeded event, positioned in a stage. The stage-delete tests care about
   * where a card is and nothing else about it.
   */
  const cardIn = (id: string, name: string, stage: string) => ({
    id,
    eventId,
    name,
    stage,
    ownerId: "seed-organizer",
    nextAction: null,
    nextActionAt: null,
    contacts: [],
    activities: [],
    speakerId: null,
    convertedAt: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  });

  it("refuses a stage save when a card arrives after the caller read the board", async () => {
    const migrated = await migratedRuntime("crm-save-stage-race");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const prospect = cardIn(
      "10000000-0000-4000-8000-000000000049",
      "Arrives during stage edit",
      "identified",
    );
    await repository.create(prospect);

    // The editor saw Engaged empty and prepared a board without it.
    const staleBoard = await repository.listStages(eventId);
    const withoutEngaged = staleBoard
      .filter(({ key }) => key !== "engaged")
      .map((stage, sortOrder) => ({ ...stage, sortOrder }));

    // A second writer moves a card in before the list is saved. The trigger evaluates the row
    // count inside the save transaction; a service-side count taken above would already be stale.
    await database
      .prepare("UPDATE crm_prospects SET stage='engaged' WHERE id=?")
      .bind(prospect.id)
      .run();
    await expect(repository.saveStages(eventId, withoutEngaged)).rejects.toBeInstanceOf(
      PipelineStageInUseError,
    );

    expect((await repository.listStages(eventId)).some(({ key }) => key === "engaged")).toBe(true);
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "engaged",
    });
  });

  it("refuses a card move when its target stage disappears after the caller read the board", async () => {
    const migrated = await migratedRuntime("crm-move-stage-race");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const prospect = cardIn(
      "10000000-0000-4000-8000-000000000053",
      "Moves after stage deletion",
      "identified",
    );
    await repository.create(prospect);

    const board = await repository.listStages(eventId);
    await repository.saveStages(eventId, [
      ...board,
      {
        id: "15030000-0000-4000-8000-000000000001",
        eventId,
        key: "future-fit",
        label: "Future fit",
        category: "open",
        sortOrder: board.length,
        createdAt: "2026-08-12T12:00:00.000Z",
      },
    ]);
    const staleBoard = await repository.listStages(eventId);
    expect(staleBoard.some(({ key }) => key === "future-fit")).toBe(true);
    await repository.saveStages(
      eventId,
      staleBoard
        .filter(({ key }) => key !== "future-fit")
        .map((stage, sortOrder) => ({ ...stage, sortOrder })),
    );

    await expect(
      repository.update(
        { ...prospect, stage: "future-fit", updatedAt: "2026-08-12T12:05:00.000Z" },
        [],
        undefined,
        {
          toStage: "future-fit",
          actorId: "seed-organizer",
          source: "board",
          occurredAt: "2026-08-12T12:05:00.000Z",
        },
      ),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "identified",
      activities: [],
    });
    const transitions = await migrated.database
      .prepare("SELECT id FROM crm_prospect_transitions WHERE prospect_id=?")
      .bind(prospect.id)
      .all();
    expect(transitions.results).toEqual([]);
  });

  it("refuses a new card when its entry stage disappears after the caller read the board", async () => {
    const migrated = await migratedRuntime("crm-create-stage-race");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const staleBoard = await repository.listStages(eventId);
    expect(staleBoard.some(({ key }) => key === "future-fit")).toBe(true);
    await repository.saveStages(
      eventId,
      staleBoard
        .filter(({ key }) => key !== "future-fit")
        .map((stage, sortOrder) => ({ ...stage, sortOrder })),
    );
    const prospect = cardIn(
      "10000000-0000-4000-8000-000000000054",
      "Created after stage deletion",
      "future-fit",
    );

    await expect(repository.create(prospect)).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(repository.findById(eventId, prospect.id)).resolves.toBeNull();
  });

  it("maps a stage migration whose target disappeared to the board refusal", async () => {
    const migrated = await migratedRuntime("crm-delete-target-stage-race");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const board = await repository.listStages(eventId);
    const source = {
      id: "15030000-0000-4000-8000-000000000003",
      eventId,
      key: "temporary-source",
      label: "Temporary source",
      category: "open" as const,
      sortOrder: board.length,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    await repository.saveStages(eventId, [...board, source]);
    const prospect = cardIn(
      "10000000-0000-4000-8000-000000000055",
      "Migrated after target deletion",
      source.key,
    );
    await repository.create(prospect);
    const staleBoard = await repository.listStages(eventId);
    await repository.saveStages(
      eventId,
      staleBoard
        .filter(({ key }) => key !== "future-fit")
        .map((stage, sortOrder) => ({ ...stage, sortOrder })),
    );

    await expect(
      repository.deleteStage(
        eventId,
        source.key,
        "future-fit",
        {
          actorId: "seed-organizer",
          source: "migration",
          occurredAt: "2026-08-12T12:05:00.000Z",
        },
        staleBoard.filter(({ key }) => key !== source.key),
      ),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: source.key,
    });
    expect((await repository.listStages(eventId)).some(({ key }) => key === source.key)).toBe(true);
  });

  it("gives history to exactly the cards a stage delete moves, not to the ones a stale read named", async () => {
    const migrated = await migratedRuntime("crm-delete-stage-stale");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * `CrmService.deletePipelineStage` computes its transition list from a `list()` of the stage,
     * a round trip before the write, while the migration is a predicate — `WHERE event_id=? AND
     * stage=?` — evaluated at write time. The two drifted apart in both directions: a card
     * dragged out of the stage in between kept a transition row for a move that never happened,
     * and a card dragged into it was migrated with no history at all.
     */
    const staying = "10000000-0000-4000-8000-000000000050";
    const leaving = "10000000-0000-4000-8000-000000000051";
    const arriving = "10000000-0000-4000-8000-000000000052";
    await repository.create(cardIn(staying, "Stays in Engaged", "engaged"));
    await repository.create(cardIn(leaving, "Dragged out before the write", "engaged"));
    await repository.create(cardIn(arriving, "Dragged in after the read", "identified"));

    // The snapshot the service takes, and the list it builds from it.
    const snapshot = await repository.list(eventId, { stage: "engaged" });
    expect(snapshot.map(({ id }) => id)).toEqual(
      expect.arrayContaining([staying, leaving, "50000000-0000-4000-8000-000000000002"]),
    );
    const occurredAt = "2026-08-12T13:00:00.000Z";
    // The snapshot above is deliberately *not* handed to the write any more — that was the
    // defect. It is taken here only to prove the two sets genuinely differ by the time the write
    // runs, so this test would still catch a repository that went back to trusting a caller.
    const move = { actorId: "seed-organizer", source: "detail" as const, occurredAt };

    // Two organizers, one board: between that read and this write the stage loses a card and
    // gains one.
    await database
      .prepare("UPDATE crm_prospects SET stage='invited' WHERE id=?")
      .bind(leaving)
      .run();
    await database
      .prepare("UPDATE crm_prospects SET stage='engaged' WHERE id=?")
      .bind(arriving)
      .run();

    const remaining = (await repository.listStages(eventId)).filter(({ key }) => key !== "engaged");
    await repository.deleteStage(eventId, "engaged", "contacted", move, remaining);

    const written = await database
      .prepare(
        "SELECT id, prospect_id, from_stage, to_stage, actor_id, source FROM crm_prospect_transitions WHERE event_id=? AND occurred_at=? ORDER BY prospect_id",
      )
      .bind(eventId, occurredAt)
      .all<HistoryRow>();
    const rows: HistoryRow[] = written.results ?? [];
    // Exactly the cards standing in the stage when the batch ran: the two that were there, plus
    // the late arrival — and not the one that left, whose row the caller's list still asked for.
    expect(rows.map(({ prospect_id }) => prospect_id)).toEqual([
      staying,
      arriving,
      "50000000-0000-4000-8000-000000000002",
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        from_stage: "engaged",
        to_stage: "contacted",
        actor_id: "seed-organizer",
        source: "detail",
      });
    // Each row carries its own id, generated per result row rather than once for the statement:
    // a shared id would have been refused by the primary key, which is what makes this the
    // assertion that the SQL generator is re-evaluated.
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    for (const { id } of rows)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

    // And the cards themselves: the arrival moved, the departure was left where it went.
    await expect(repository.findById(eventId, arriving)).resolves.toMatchObject({
      stage: "contacted",
      updatedAt: occurredAt,
    });
    await expect(repository.findById(eventId, leaving)).resolves.toMatchObject({
      stage: "invited",
    });
  });

  it("stamps a stage delete with the clock rather than 1970 when the caller's list is empty", async () => {
    const migrated = await migratedRuntime("crm-delete-stage-empty-list");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The extreme of the same staleness: the read found the stage empty, so there is no
     * transition to take a clock reading from — and the card that arrived a moment later was
     * migrated with `updated_at` set to the Unix epoch, which sorts a freshly moved card to the
     * bottom of every "recently touched" view there is.
     */
    const arriving = "10000000-0000-4000-8000-000000000060";
    await repository.create(cardIn(arriving, "Arrived into an empty stage", "invited"));
    const remaining = (await repository.listStages(eventId)).filter(({ key }) => key !== "invited");

    const before = new Date().toISOString();
    await repository.deleteStage(
      eventId,
      "invited",
      "contacted",
      { actorId: "seed-organizer", source: "detail", occurredAt: before },
      remaining,
    );
    const after = new Date().toISOString();

    const moved = await repository.findById(eventId, arriving);
    if (!moved) throw new Error("The migrated prospect is missing");
    expect(moved.stage).toBe("contacted");
    expect(moved.updatedAt.startsWith("1970")).toBe(false);
    expect(moved.updatedAt >= before && moved.updatedAt <= after).toBe(true);
    // It is recorded too, and attributed to the organizer who asked for the delete. There is no
    // longer a case where the write has rows to move but nobody to attribute them to: the caller
    // passes the actor rather than a list that might be empty.
    const history = await database
      .prepare(
        "SELECT actor_id, source, from_stage, to_stage, occurred_at FROM crm_prospect_transitions WHERE prospect_id=?",
      )
      .bind(arriving)
      .all<{
        actor_id: string;
        source: string;
        from_stage: string | null;
        to_stage: string;
        occurred_at: string;
      }>();
    expect(history.results).toEqual([
      {
        actor_id: "seed-organizer",
        source: "detail",
        from_stage: "invited",
        to_stage: "contacted",
        occurred_at: moved.updatedAt,
      },
    ]);
  });

  it("scopes assignable prospect owners to one event and excludes speakers", async () => {
    const migrated = await migratedRuntime("crm-owner-eligibility");
    runtime = migrated.runtime;
    const database = migrated.database;
    const directory = new D1IdentityDirectory(database);

    // Seeded event one: an organizer who also reviews there, plus its two reviewers.
    // `seed-speaker` holds only the speaker role, so it is not offered — the identity the live
    // API used to accept as a prospect owner.
    await expect(directory.listAssignableOwnersForEvent(eventId)).resolves.toEqual([
      { id: "review-nina-alvarez", name: "Nina Alvarez" },
      { id: "seed-organizer", name: "Olivia Organizer" },
      { id: "seed-reviewer", name: "Ravi Reviewer" },
    ]);

    // Eligibility does not travel between events: a reviewer on event one is absent from the
    // neighbouring event's list even though both belong to the same organization.
    await expect(directory.listAssignableOwnersForEvent(otherEventId)).resolves.toEqual([
      { id: "seed-organizer", name: "Olivia Organizer" },
    ]);
    await expect(
      directory.listAssignableOwnersForEvent("00000000-0000-4000-8000-000000000099"),
    ).resolves.toEqual([]);

    // The foreign key this eligibility check stands in front of is real: an owner the directory
    // would have refused cannot be stored at all.
    const repository = new D1CrmRepository(database);
    await expect(
      repository.create({
        id: "10000000-0000-4000-8000-000000000030",
        eventId,
        name: "Unknown owner",
        stage: "identified",
        ownerId: "not-a-real-user-at-all",
        nextAction: null,
        nextActionAt: null,
        contacts: [],
        activities: [],
        speakerId: null,
        convertedAt: null,
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).rejects.toThrow();
  });
});

const organizationId = "00000000-0000-4000-8000-000000000010";
const otherOrganizationId = "00000000-0000-4000-8000-000000000020";
const adaId = "51000000-0000-4000-8000-000000000001";
const priyaId = "51000000-0000-4000-8000-000000000003";
const priyaDuplicateId = "51000000-0000-4000-8000-000000000004";

const contactAt = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  organizationId,
  name: "Directory Person",
  email: `${id}@example.test`,
  company: null,
  title: null,
  notes: null,
  source: "manual" as const,
  mergedIntoId: null,
  tags: [] as string[],
  fields: [] as { key: string; value: string }[],
  aliases: [],
  events: [],
  activities: [],
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
  ...overrides,
});

describe("D1 CRM organization directory", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("returns the seeded directory scoped to its organization, one row per person", async () => {
    const migrated = await migratedRuntime("crm-directory");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);

    const contacts = await repository.listContacts(organizationId, {});
    // Ordered by name, then id — the two Priyas are the seeded near-duplicate pair.
    expect(contacts.map(({ email }) => email)).toEqual([
      "ada@example.test",
      "morgan@example.test",
      "priya@example.test",
      "p.raman@eastwind.test",
    ]);
    // The person courted for two events appears once, carrying both histories, and each link's
    // stage is read from that event's prospect rather than from a copy on the link.
    const ada = contacts.find(({ id }) => id === adaId);
    expect(ada?.events.map(({ eventId: id, stage }) => [id, stage])).toEqual([
      [eventId, "contacted"],
      [otherEventId, "identified"],
    ]);
    expect(ada?.tags).toEqual(["accessibility", "keynote"]);
    expect(ada?.fields).toEqual([
      { key: "timezone", value: "America/Los_Angeles" },
      { key: "topic", value: "Inclusive event design" },
    ]);

    // The other organization's directory is empty, and asking for it by id returns nothing
    // rather than somebody else's row.
    await expect(repository.listContacts(otherOrganizationId, {})).resolves.toEqual([]);
    await expect(repository.findContact(otherOrganizationId, adaId)).resolves.toBeNull();
    await expect(
      repository.findContactByEmail(otherOrganizationId, "ada@example.test"),
    ).resolves.toBeNull();
  });

  it("filters in SQL the way the domain filters in memory", async () => {
    const migrated = await migratedRuntime("crm-filters");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const names = async (filters: Parameters<typeof repository.listContacts>[1]) =>
      (await repository.listContacts(organizationId, filters)).map(({ name }) => name);

    expect(await names({ company: "northwind access" })).toEqual(["Dr. Ada Rivera"]);
    expect(await names({ title: "Design Lead" })).toEqual(["Priya Raman", "Priya Raman"]);
    expect(await names({ tags: ["keynote"] })).toEqual(["Dr. Ada Rivera"]);
    // Every named tag, not any of them.
    expect(await names({ tags: ["keynote", "design"] })).toEqual([]);
    expect(await names({ fieldKey: "topic", fieldValue: "Responsible AI" })).toEqual([
      "Morgan Chen",
    ]);
    expect(await names({ eventId: otherEventId })).toEqual(["Dr. Ada Rivera"]);
    expect(await names({ search: "morgan@" })).toEqual(["Morgan Chen"]);
  });

  it("refuses a second live contact on one address, and admits one after the merge", async () => {
    const migrated = await migratedRuntime("crm-unique-email");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    // The partial unique index, not a service-level check, is what makes "one row per person"
    // true of the stored data.
    await expect(
      repository.createContact(
        contactAt("51000000-0000-4000-8000-0000000000a1", { email: "ada@example.test" }),
      ),
    ).rejects.toThrow();

    await repository.mergeContacts({
      organizationId,
      primaryId: priyaId,
      duplicateIds: [priyaDuplicateId],
      aliases: [
        {
          id: "54000000-0000-4000-8000-000000000001",
          name: "Priya Raman",
          email: "p.raman@eastwind.test",
          mergedFromId: priyaDuplicateId,
          mergedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
      activity: {
        id: "71000000-0000-4000-8000-0000000000a1",
        kind: "merge",
        summary: "Merged p.raman@eastwind.test into this contact",
        private: false,
        occurredAt: "2026-08-11T12:00:00.000Z",
        actorId: "seed-organizer",
      },
    });
    // The merged-away row keeps its address and leaves the index, so the address becomes
    // reusable — and the survivor is still findable under it.
    await expect(
      repository.createContact(
        contactAt("51000000-0000-4000-8000-0000000000a2", { email: "p.raman@eastwind.test" }),
      ),
    ).resolves.toBeUndefined();
    expect(
      (await repository.listContacts(organizationId, { search: "p.raman@eastwind" })).map(
        ({ id }) => id,
      ),
    ).toContain(priyaId);
  });

  it("moves history, tags and event links onto the primary and leaves nothing deleted", async () => {
    const migrated = await migratedRuntime("crm-merge");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    // Give the loser a pipeline row and a link to it, so the merge has something structural to
    // move rather than only history.
    const loserProspectId = "50000000-0000-4000-8000-0000000000d1";
    await database
      .prepare(
        "INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES (?,?,?,?,?,NULL,NULL,?,?)",
      )
      .bind(
        loserProspectId,
        eventId,
        "Priya Raman",
        "identified",
        "seed-organizer",
        "2026-08-04T12:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
      )
      .run();
    await database
      .prepare(
        "INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) VALUES (?,?,?,?)",
      )
      .bind(priyaDuplicateId, eventId, loserProspectId, "2026-08-04T12:00:00.000Z")
      .run();

    const merged = await repository.mergeContacts({
      organizationId,
      primaryId: priyaId,
      duplicateIds: [priyaDuplicateId],
      aliases: [
        {
          id: "54000000-0000-4000-8000-000000000002",
          name: "Priya Raman",
          email: "p.raman@eastwind.test",
          mergedFromId: priyaDuplicateId,
          mergedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
      activity: {
        id: "71000000-0000-4000-8000-0000000000a2",
        kind: "merge",
        summary: "Merged p.raman@eastwind.test into this contact",
        private: false,
        occurredAt: "2026-08-11T12:00:00.000Z",
        actorId: "seed-organizer",
      },
    });
    expect(merged.aliases.map(({ email }) => email)).toEqual(["p.raman@eastwind.test"]);
    expect(merged.events.map(({ eventId: id }) => id)).toEqual([eventId]);
    expect(merged.activities.map(({ kind }) => kind)).toEqual(["import", "import", "merge"]);
    expect(merged.tags).toEqual(["design"]);

    // Nothing was deleted: the loser's row survives, pointing at its primary, and is out of the
    // directory rather than out of the database.
    const loser = await repository.findContact(organizationId, priyaDuplicateId);
    expect(loser?.mergedIntoId).toBe(priyaId);
    expect((await repository.listContacts(organizationId, {})).map(({ id }) => id)).not.toContain(
      priyaDuplicateId,
    );
  });

  it("refuses a merge, a link and an activity that reach across organizations", async () => {
    const migrated = await migratedRuntime("crm-cross-organization");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const activity = {
      id: "71000000-0000-4000-8000-0000000000a3",
      kind: "merge" as const,
      summary: "Merged from another organization",
      private: false,
      occurredAt: "2026-08-11T12:00:00.000Z",
      actorId: "seed-organizer",
    };
    // Every directory statement carries the organization, so naming the wrong one folds nothing
    // away even though both ids exist.
    await expect(
      repository.mergeContacts({
        organizationId: otherOrganizationId,
        primaryId: priyaId,
        duplicateIds: [priyaDuplicateId],
        aliases: [],
        activity,
      }),
    ).rejects.toThrow();
    expect(
      (await repository.findContact(organizationId, priyaDuplicateId))?.mergedIntoId,
    ).toBeNull();

    await repository.recordContactActivities(otherOrganizationId, [
      {
        contactId: adaId,
        activity: { ...activity, id: "71000000-0000-4000-8000-0000000000a4", kind: "note" },
      },
    ]);
    expect((await repository.findContact(organizationId, adaId))?.activities).toHaveLength(2);
  });

  it("will not fold a duplicate from another organization into a primary in this one", async () => {
    const migrated = await migratedRuntime("crm-merge-foreign-duplicate");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The case the test above does *not* cover: the organization and the primary agree, and
     * only the duplicate is foreign. Scoping the statements by the primary alone let this move
     * another organization's private history onto a contact here and leave the foreign record
     * live with its timeline emptied — a cross-tenant read and a data loss in one statement.
     */
    const foreignId = "51000000-0000-4000-8000-0000000000e1";
    await repository.createContact(
      contactAt(foreignId, {
        organizationId: otherOrganizationId,
        name: "Priya Raman",
        email: "priya@outside.test",
        company: "Eastwind Studio",
        tags: ["confidential"],
        activities: [
          {
            id: "71000000-0000-4000-8000-0000000000e1",
            kind: "note",
            summary: "Another organization's private note",
            private: true,
            occurredAt: "2026-08-11T12:00:00.000Z",
            actorId: "seed-organizer",
          },
        ],
      }),
    );

    await repository.mergeContacts({
      organizationId,
      primaryId: priyaId,
      duplicateIds: [foreignId],
      aliases: [],
      activity: {
        id: "71000000-0000-4000-8000-0000000000e2",
        kind: "merge",
        summary: "Merged a foreign id",
        private: false,
        occurredAt: "2026-08-11T12:00:00.000Z",
        actorId: "seed-organizer",
      },
    });

    // The primary gained only its own merge entry, and none of the foreign record's history.
    const primary = await repository.findContact(organizationId, priyaId);
    expect(primary?.activities.map(({ summary }) => summary)).not.toContain(
      "Another organization's private note",
    );
    expect(primary?.tags).not.toContain("confidential");
    // And the foreign record is untouched: still live, still holding its own timeline.
    const foreign = await repository.findContact(otherOrganizationId, foreignId);
    expect(foreign?.mergedIntoId).toBeNull();
    expect(foreign?.activities).toHaveLength(1);
    expect(foreign?.tags).toEqual(["confidential"]);
  });

  it("will not retire this organization's contacts into a primary from another one", async () => {
    const migrated = await migratedRuntime("crm-merge-foreign-primary");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    /*
     * The mirror image of the case above, and the worse one. Scoping the losers but not the
     * primary let a foreign `primaryId` point this organization's live contacts at a record
     * nobody here can open — they leave the directory with no undo route — and wrote an
     * activity row onto another organization's contact, which is a cross-tenant *write*.
     */
    const foreignPrimary = "51000000-0000-4000-8000-0000000000e5";
    await repository.createContact(
      contactAt(foreignPrimary, {
        organizationId: otherOrganizationId,
        name: "Outside Primary",
        email: "outside-primary@outside.test",
      }),
    );

    await expect(
      repository.mergeContacts({
        organizationId,
        primaryId: foreignPrimary,
        duplicateIds: [priyaId],
        aliases: [],
        activity: {
          id: "71000000-0000-4000-8000-0000000000e6",
          kind: "merge",
          summary: "Merge driven by a foreign primary",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      }),
      // The trailing read cannot find the primary in this organization, so the call fails —
      // but the assertions that matter are that the batch changed nothing.
    ).rejects.toBeInstanceOf(ContactNotFoundError);

    // This organization's contact is still live and still listed.
    const priya = await repository.findContact(organizationId, priyaId);
    expect(priya?.mergedIntoId).toBeNull();
    expect((await repository.listContacts(organizationId, {})).map(({ id }) => id)).toContain(
      priyaId,
    );
    // And nothing was written onto the other organization's contact.
    const outside = await repository.findContact(otherOrganizationId, foreignPrimary);
    expect(outside?.activities).toEqual([]);
  });

  it("will not edit, strip or annotate a contact belonging to another organization", async () => {
    const migrated = await migratedRuntime("crm-update-foreign");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    /*
     * The contact row's own UPDATE was organization-scoped from the start, but its tags, custom
     * fields and timeline are child rows keyed on `contact_id` alone — so replacing this
     * contact's tags wholesale reached across and *deleted* another organization's. The same
     * asymmetry as the merge batch, and the destructive version of it.
     */
    const foreignId = "51000000-0000-4000-8000-0000000000f9";
    await repository.createContact(
      contactAt(foreignId, {
        organizationId: otherOrganizationId,
        name: "Outside Person",
        email: "outside-person@outside.test",
        tags: ["board", "confidential"],
        fields: [{ key: "clearance", value: "top" }],
      }),
    );
    const before = await repository.findContact(otherOrganizationId, foreignId);

    // The organization is overstated; every statement must refuse it, not just the first.
    await repository.updateContact(
      {
        ...contactAt(foreignId, {
          organizationId,
          name: "Renamed by an outsider",
          email: "outside-person@outside.test",
          tags: ["hijacked"],
          fields: [{ key: "hijacked", value: "yes" }],
        }),
      },
      [
        {
          id: "71000000-0000-4000-8000-0000000000f9",
          kind: "note",
          summary: "Written from another organization",
          private: true,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      ],
    );

    const after = await repository.findContact(otherOrganizationId, foreignId);
    expect(after?.name).toBe("Outside Person");
    expect(after?.tags).toEqual(before?.tags);
    expect(after?.fields).toEqual(before?.fields);
    expect(after?.activities).toEqual([]);
  });

  it("applies no half of an update to a contact merged away since the caller read it", async () => {
    const migrated = await migratedRuntime("crm-update-merged");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(migrated.database);
    /*
     * The contact row's UPDATE refused a merged-away record while its tags, fields and timeline
     * accepted one, so a row the directory no longer lists had its history rewritten and its
     * tags destroyed. The same one-sided shape as the cross-organization case, one condition
     * further in — which is why ownership and liveness are now a single clause.
     */
    const stored = await repository.findContact(organizationId, priyaDuplicateId);
    if (!stored) throw new Error("The seeded contact is missing");
    await database
      .prepare("UPDATE crm_organization_contacts SET merged_into_id = ? WHERE id = ?")
      .bind(priyaId, priyaDuplicateId)
      .run();

    await repository.updateContact(
      {
        ...stored,
        name: "Renamed after the merge",
        tags: ["replaced"],
        fields: [],
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
      [
        {
          id: "71000000-0000-4000-8000-0000000000fb",
          kind: "note",
          summary: "Written after the merge",
          private: true,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      ],
    );

    const after = await repository.findContact(organizationId, priyaDuplicateId);
    expect(after?.name).toBe(stored.name);
    expect(after?.tags).toEqual(stored.tags);
    // The fields too: the update sent `fields: []`, which is what makes the field DELETE fire,
    // so asserting only the name and tags would stay green if that statement's guard regressed.
    expect(after?.fields).toEqual(stored.fields);
    expect(after?.activities.map(({ summary }) => summary)).toEqual(
      stored.activities.map(({ summary }) => summary),
    );
  });

  it("records an activity for a merged-away contact on the survivor rather than losing it", async () => {
    const migrated = await migratedRuntime("crm-activity-survivor");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The one write that must not simply refuse a merged-away contact: by the time outreach
     * records its entry the message has been delivered and a delivery id returned, so dropping
     * the entry loses the only trace of a send that really happened.
     */
    await database
      .prepare("UPDATE crm_organization_contacts SET merged_into_id = ? WHERE id = ?")
      .bind(priyaId, priyaDuplicateId)
      .run();

    await repository.recordContactActivities(organizationId, [
      {
        contactId: priyaDuplicateId,
        activity: {
          id: "71000000-0000-4000-8000-0000000000fc",
          kind: "outreach",
          summary: 'Sent "speaker-invite" (delivery delivery-1)',
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      },
    ]);

    const survivor = await repository.findContact(organizationId, priyaId);
    expect(survivor?.activities.map(({ summary }) => summary)).toContain(
      'Sent "speaker-invite" (delivery delivery-1)',
    );
    // And an id from another organization still records nothing at all.
    await repository.recordContactActivities(otherOrganizationId, [
      {
        contactId: priyaId,
        activity: {
          id: "71000000-0000-4000-8000-0000000000fd",
          kind: "note",
          summary: "From another organization",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      },
    ]);
    expect(
      (await repository.findContact(organizationId, priyaId))?.activities.map(
        ({ summary }) => summary,
      ),
    ).not.toContain("From another organization");
  });

  it("writes no pipeline row when the directory link is refused", async () => {
    const migrated = await migratedRuntime("crm-link-refused");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * Gating only the link left a prospect behind that no link pointed at. Reachable without a
     * hostile caller: a contact merged away between the service's read and this batch takes the
     * same path, and the timeline then claimed a sourcing that never happened.
     */
    const merged = await repository.findContact(organizationId, priyaDuplicateId);
    if (!merged) throw new Error("The seeded contact is missing");
    await database
      .prepare("UPDATE crm_organization_contacts SET merged_into_id = ? WHERE id = ?")
      .bind(priyaId, priyaDuplicateId)
      .run();

    const prospectId = "50000000-0000-4000-8000-0000000000fa";
    await repository.linkContactToEvent({
      contact: merged,
      prospect: {
        id: prospectId,
        eventId,
        name: "Priya Raman",
        stage: "identified",
        ownerId: "seed-organizer",
        nextAction: null,
        nextActionAt: null,
        contacts: [
          {
            id: "60000000-0000-4000-8000-0000000000fa",
            name: "Priya Raman",
            email: "p.raman@eastwind.test",
            isPrimary: true,
          },
        ],
        activities: [],
        speakerId: null,
        convertedAt: null,
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
      activity: {
        id: "71000000-0000-4000-8000-0000000000fa",
        kind: "note",
        summary: "Sourced into an event",
        private: false,
        occurredAt: "2026-08-11T12:00:00.000Z",
        actorId: "seed-organizer",
      },
    });

    // Either the whole sourcing lands or none of it does: no orphan prospect, no contact row
    // for it, and no timeline entry claiming it happened.
    await expect(repository.findById(eventId, prospectId)).resolves.toBeNull();
    const orphans = await database
      .prepare("SELECT id FROM crm_contacts WHERE prospect_id = ?")
      .bind(prospectId)
      .all();
    expect(orphans.results ?? []).toHaveLength(0);
    // The contact keeps the history it already had, and gains no entry claiming a sourcing
    // that was refused.
    const timeline = (await repository.findContact(organizationId, priyaDuplicateId))?.activities;
    expect(timeline?.map(({ summary }) => summary)).toEqual(["Imported from speakers-2026.csv"]);
  });

  it("writes no part of a merge whose primary was merged away first", async () => {
    const migrated = await migratedRuntime("crm-merge-dead-primary");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The case the other merge tests skip: the organization and both ids are right, and the
     * primary has itself been merged away since the service checked. Six of the batch's seven
     * statements refused it and the seventh — the alias insert — did not, so the survivor
     * gained an alias for a duplicate that was never retired, on a row the directory no longer
     * lists. A merge cannot be undone, so a merge that half-applies is the worst outcome here.
     */
    await database
      .prepare("UPDATE crm_organization_contacts SET merged_into_id = ? WHERE id = ?")
      .bind(adaId, priyaId)
      .run();

    // And the caller is told, rather than handed back the dead primary as a successful merge:
    // `findContact` resolves merged-away rows on purpose, so returning it reported a fold that
    // never happened.
    await expect(
      repository.mergeContacts({
        organizationId,
        primaryId: priyaId,
        duplicateIds: [priyaDuplicateId],
        aliases: [
          {
            id: "54000000-0000-4000-8000-0000000000e1",
            name: "Priya Raman",
            email: "p.raman@eastwind.test",
            mergedFromId: priyaDuplicateId,
            mergedAt: "2026-08-11T12:00:00.000Z",
          },
        ],
        activity: {
          id: "71000000-0000-4000-8000-0000000000e1",
          kind: "merge",
          summary: "Merged into a primary that was already merged away",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      }),
    ).rejects.toBeInstanceOf(ContactNotFoundError);

    // Nothing at all: no alias, no retired duplicate, no merge entry.
    const aliases = await database
      .prepare("SELECT id FROM crm_contact_aliases WHERE contact_id = ?")
      .bind(priyaId)
      .all();
    expect(aliases.results ?? []).toHaveLength(0);
    expect(
      (await repository.findContact(organizationId, priyaDuplicateId))?.mergedIntoId,
    ).toBeNull();
    expect(
      (await repository.findContact(organizationId, priyaId))?.activities.map(({ kind }) => kind),
    ).not.toContain("merge");
  });

  it("keeps both links when the merged records were sourced into the same event", async () => {
    const migrated = await migratedRuntime("crm-merge-same-event");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * The one path where a merge does not move something. `crm_contact_events` is keyed on
     * `(contact_id, event_id)`, so the loser's link cannot follow the winner's onto one row;
     * `UPDATE OR IGNORE` leaves it where it is. `PRD-CRM-001` states this exception, and until
     * now nothing exercised it — both records having a link to the *same* event is the case the
     * other merge tests skip.
     */
    const prospectFor = async (id: string, name: string) => {
      await database
        .prepare(
          "INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES (?,?,?,'identified','seed-organizer',NULL,NULL,?,?)",
        )
        .bind(id, eventId, name, "2026-08-04T12:00:00.000Z", "2026-08-04T12:00:00.000Z")
        .run();
      return id;
    };
    await prospectFor("50000000-0000-4000-8000-0000000000f1", "Priya Raman");
    await prospectFor("50000000-0000-4000-8000-0000000000f2", "Priya Raman");
    const link = (contactId: string, prospectId: string) =>
      database
        .prepare(
          "INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) VALUES (?,?,?,?)",
        )
        .bind(contactId, eventId, prospectId, "2026-08-04T12:00:00.000Z")
        .run();
    await link(priyaId, "50000000-0000-4000-8000-0000000000f1");
    await link(priyaDuplicateId, "50000000-0000-4000-8000-0000000000f2");

    const merged = await repository.mergeContacts({
      organizationId,
      primaryId: priyaId,
      duplicateIds: [priyaDuplicateId],
      aliases: [],
      activity: {
        id: "71000000-0000-4000-8000-0000000000f1",
        kind: "merge",
        summary: "Merged a same-event duplicate",
        private: false,
        occurredAt: "2026-08-11T12:00:00.000Z",
        actorId: "seed-organizer",
      },
    });

    // The survivor keeps exactly its own link for that event — one link, not two.
    expect(merged.events).toEqual([
      expect.objectContaining({
        eventId,
        prospectId: "50000000-0000-4000-8000-0000000000f1",
      }),
    ]);
    // And the loser's link is retained on the merged-away row rather than deleted.
    const loser = await repository.findContact(organizationId, priyaDuplicateId);
    expect(loser?.mergedIntoId).toBe(priyaId);
    expect(loser?.events.map(({ prospectId }) => prospectId)).toEqual([
      "50000000-0000-4000-8000-0000000000f2",
    ]);
  });

  it("reports a racing duplicate address and a double-sourced event as conflicts, not faults", async () => {
    const migrated = await migratedRuntime("crm-races");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    /*
     * D1 rejects `batch()` on a statement error rather than returning a non-success result, so
     * an adapter that inspected only the results array left both of these as redacted 500s —
     * the very failure state `ContactEmailTakenError` exists to prevent.
     */
    await expect(
      repository.createContact(
        contactAt("51000000-0000-4000-8000-0000000000e7", { email: "ada@example.test" }),
      ),
    ).rejects.toBeInstanceOf(ContactEmailTakenError);

    const contact = await repository.findContact(organizationId, priyaId);
    if (!contact) throw new Error("The seeded contact is missing");
    const prospect = {
      id: "50000000-0000-4000-8000-0000000000e8",
      eventId,
      name: "Priya Raman",
      stage: "identified" as const,
      ownerId: "seed-organizer",
      nextAction: null,
      nextActionAt: null,
      contacts: [],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const activity = {
      id: "71000000-0000-4000-8000-0000000000e8",
      kind: "note" as const,
      summary: "Sourced",
      private: false,
      occurredAt: "2026-08-11T12:00:00.000Z",
      actorId: "seed-organizer",
    };
    await repository.linkContactToEvent({ contact, prospect, activity });
    await expect(
      repository.linkContactToEvent({
        contact,
        prospect: { ...prospect, id: "50000000-0000-4000-8000-0000000000e9" },
        activity: { ...activity, id: "71000000-0000-4000-8000-0000000000e9" },
      }),
    ).rejects.toBeInstanceOf(ContactAlreadySourcedError);

    // A violation that is not one of those two stays a fault rather than becoming a false
    // conflict: this one breaks the name-length CHECK, not a unique index.
    await expect(
      repository.createContact(
        contactAt("51000000-0000-4000-8000-0000000000ea", {
          email: "long-name@example.test",
          name: "x".repeat(200),
        }),
      ),
    ).rejects.not.toBeInstanceOf(ContactEmailTakenError);
  });

  it("writes the prospect, its contact and the directory link in one durable operation", async () => {
    const migrated = await migratedRuntime("crm-link");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const contact = await repository.findContact(organizationId, priyaId);
    const prospect = {
      id: "50000000-0000-4000-8000-0000000000b1",
      eventId,
      name: "Priya Raman",
      stage: "identified" as const,
      ownerId: "seed-organizer",
      nextAction: "Confirm interest for this event",
      nextActionAt: null,
      contacts: [
        {
          id: "60000000-0000-4000-8000-0000000000b1",
          name: "Priya Raman",
          email: "priya@example.test",
          isPrimary: true,
        },
      ],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const activity = {
      id: "71000000-0000-4000-8000-0000000000b1",
      kind: "note" as const,
      summary: `Sourced into event ${eventId}`,
      private: false,
      occurredAt: "2026-08-11T12:00:00.000Z",
      actorId: "seed-organizer",
    };
    if (!contact) throw new Error("The seeded contact is missing");

    await database
      .prepare(
        "CREATE TRIGGER fail_contact_link BEFORE INSERT ON crm_contact_events BEGIN SELECT RAISE(FAIL, 'injected link failure'); END",
      )
      .run();
    await expect(repository.linkContactToEvent({ contact, prospect, activity })).rejects.toThrow();
    // The prospect must not survive a link that failed, or the pipeline would hold a row the
    // directory has no record of.
    await expect(repository.findById(eventId, prospect.id)).resolves.toBeNull();
    await database.prepare("DROP TRIGGER fail_contact_link").run();

    await repository.linkContactToEvent({ contact, prospect, activity });
    const linked = await repository.findContact(organizationId, priyaId);
    expect(linked?.events).toEqual([
      expect.objectContaining({ eventId, prospectId: prospect.id, stage: "identified" }),
    ]);
    // And one prospect belongs to at most one contact.
    await expect(
      database
        .prepare(
          "INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) VALUES (?,?,?,?)",
        )
        .bind(priyaDuplicateId, eventId, prospect.id, "2026-08-11T12:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });

  it("maps a directory source whose entry stage disappeared and writes no partial link", async () => {
    const migrated = await migratedRuntime("crm-directory-stage-race");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const contact = await repository.findContact(organizationId, priyaId);
    if (!contact) throw new Error("The seeded contact is missing");
    const prospectId = "50000000-0000-4000-8000-0000000000bc";

    await expect(
      repository.linkContactToEvent({
        contact,
        prospect: {
          id: prospectId,
          eventId,
          name: contact.name,
          stage: "stage-deleted-after-read",
          ownerId: "seed-organizer",
          nextAction: null,
          nextActionAt: null,
          contacts: [],
          activities: [],
          speakerId: null,
          convertedAt: null,
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
        activity: {
          id: "71000000-0000-4000-8000-0000000000bc",
          kind: "note",
          summary: "Sourced after a stale board read",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      }),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(repository.findById(eventId, prospectId)).resolves.toBeNull();
    expect((await repository.findContact(organizationId, priyaId))?.events).toEqual([]);
  });

  it("adopts an existing prospect by normalized primary address with link history atomically", async () => {
    const migrated = await migratedRuntime("crm-adopt-existing");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const contact = await repository.findContact(organizationId, priyaId);
    if (!contact) throw new Error("The seeded contact is missing");
    const tracked = {
      id: "50000000-0000-4000-8000-0000000000b2",
      eventId,
      name: "Priya before the directory",
      stage: "contacted" as const,
      ownerId: "seed-organizer",
      nextAction: "Keep this history",
      nextActionAt: null,
      contacts: [
        {
          id: "60000000-0000-4000-8000-0000000000b2",
          name: "Priya Raman",
          email: "  PRIYA@Example.Test ",
          isPrimary: true,
        },
      ],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    await repository.create(tracked);
    await expect(
      repository.findByPrimaryEmail(eventId, "priya@example.test"),
    ).resolves.toMatchObject({ id: tracked.id });
    const activity = {
      id: "71000000-0000-4000-8000-0000000000b2",
      kind: "note" as const,
      summary: `Already tracked on event ${eventId}; linked existing prospect`,
      private: false,
      occurredAt: "2026-08-11T12:00:00.000Z",
      actorId: "seed-organizer",
    };

    const prospectCount = (await repository.list(eventId, {})).length;
    await database
      .prepare(
        "CREATE TRIGGER fail_adoption_activity BEFORE INSERT ON crm_contact_activities WHEN NEW.id='71000000-0000-4000-8000-0000000000b2' BEGIN SELECT RAISE(FAIL, 'injected adoption history failure'); END",
      )
      .run();
    await expect(
      repository.linkContactToExistingProspect({ contact, prospect: tracked, activity }),
    ).rejects.toThrow();
    await expect(repository.findContact(organizationId, priyaId)).resolves.toMatchObject({
      events: [],
    });
    await database.prepare("DROP TRIGGER fail_adoption_activity").run();

    await repository.linkContactToExistingProspect({ contact, prospect: tracked, activity });
    await expect(
      repository.linkContactToExistingProspect({
        contact,
        prospect: tracked,
        activity: { ...activity, id: "71000000-0000-4000-8000-0000000000b3" },
      }),
    ).rejects.toThrow("already in that event's pipeline");

    await expect(repository.list(eventId, {})).resolves.toHaveLength(prospectCount);
    await expect(repository.findById(eventId, tracked.id)).resolves.toMatchObject({
      name: tracked.name,
      stage: tracked.stage,
      nextAction: tracked.nextAction,
    });
    await expect(repository.findContact(organizationId, priyaId)).resolves.toMatchObject({
      events: [expect.objectContaining({ eventId, prospectId: tracked.id })],
      activities: expect.arrayContaining([
        expect.objectContaining({ id: activity.id, summary: activity.summary }),
      ]),
    });
  });

  it("records one contact conversion when concurrent pushes finish together", async () => {
    const migrated = await migratedRuntime("crm-contact-conversion-race");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const activities = [
      "71000000-0000-4000-8000-0000000000c1",
      "71000000-0000-4000-8000-0000000000c2",
    ].map((id) => ({
      id,
      private: false,
      occurredAt: "2026-08-11T12:00:00.000Z",
      actorId: "seed-organizer",
    }));

    await Promise.all(
      activities.map((activity) =>
        repository.recordContactConversion(organizationId, priyaId, eventId, activity),
      ),
    );

    const contact = await repository.findContact(organizationId, priyaId);
    expect(
      contact?.activities.filter(
        ({ kind, summary }) =>
          kind === "conversion" && summary === `Converted to a speaker on event ${eventId}`,
      ),
    ).toHaveLength(1);
  });

  it("commits an import as one operation and replaces a contact's tags rather than accreting them", async () => {
    const migrated = await migratedRuntime("crm-import");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const created = contactAt("51000000-0000-4000-8000-0000000000c1", {
      name: "Imported Person",
      email: "imported@example.test",
      source: "import",
      tags: ["keynote", "ai"],
      fields: [{ key: "topic", value: "Platform" }],
      activities: [
        {
          id: "71000000-0000-4000-8000-0000000000c1",
          kind: "import",
          summary: "Imported from speakers.csv",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      ],
    });
    await repository.commitImport(
      {
        id: "53000000-0000-4000-8000-0000000000c1",
        organizationId,
        filename: "speakers.csv",
        rowCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        importedAt: "2026-08-11T12:00:00.000Z",
        importedBy: "seed-organizer",
      },
      [created],
      [],
    );
    const stored = await repository.findContact(organizationId, created.id);
    expect(stored?.tags).toEqual(["ai", "keynote"]);
    expect(await repository.listImports(organizationId)).toHaveLength(2);

    // Tags and fields are replaced wholesale, so removing one removes it.
    await repository.updateContact({ ...created, tags: ["keynote"], fields: [] });
    const updated = await repository.findContact(organizationId, created.id);
    expect(updated?.tags).toEqual(["keynote"]);
    expect(updated?.fields).toEqual([]);
  });

  it("stores a segment as its definition and keeps it inside its organization", async () => {
    const migrated = await migratedRuntime("crm-segments");
    runtime = migrated.runtime;
    const repository = new D1CrmRepository(migrated.database);
    const segments = await repository.listSegments(organizationId);
    expect(segments).toEqual([
      expect.objectContaining({ name: "Design shortlist", filters: { tags: ["design"] } }),
    ]);
    const [design] = segments;
    await expect(repository.findSegment(otherOrganizationId, design?.id ?? "")).resolves.toBeNull();
    await expect(repository.listSegments(otherOrganizationId)).resolves.toEqual([]);
    // One name per organization.
    await expect(
      repository.createSegment({
        id: "52000000-0000-4000-8000-0000000000d1",
        organizationId,
        name: "Design shortlist",
        filters: {},
        createdAt: "2026-08-11T12:00:00.000Z",
        createdBy: "seed-organizer",
      }),
    ).rejects.toThrow();
  });

  it("degrades an unreadable saved definition to no criteria instead of failing the directory", async () => {
    const migrated = await migratedRuntime("crm-segment-definitions");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    /*
     * A row can predate the current shape, and nothing between the row and the SQL re-validates
     * it. Throwing out of `listSegments` was an untranslated 500 — and because the workspace
     * loads contacts, segments, metrics and owners together, one bad row took the whole
     * directory page down rather than just the saved-views control.
     */
    const insert = (id: string, name: string, definition: string) =>
      database
        .prepare(
          "INSERT INTO crm_contact_segments (id,organization_id,name,definition_json,created_at,created_by) VALUES (?,?,?,?,?,?)",
        )
        .bind(id, organizationId, name, definition, "2026-08-11T12:00:00.000Z", "seed-organizer")
        .run();
    await insert("52000000-0000-4000-8000-0000000000f1", "Corrupt", "not json at all");
    await insert("52000000-0000-4000-8000-0000000000f2", "Older shape", '{"search":5,"tags":"x"}');

    const segments = await repository.listSegments(organizationId);
    const byName = new Map(segments.map((segment) => [segment.name, segment.filters]));
    expect(byName.get("Corrupt")).toEqual({});
    // A criterion of the wrong type is dropped rather than handed to `String.prototype.trim`.
    expect(byName.get("Older shape")).toEqual({});
    expect(byName.get("Design shortlist")).toEqual({ tags: ["design"] });
    // And a segment that cannot be read still opens, showing everybody rather than nothing.
    await expect(
      repository.listContacts(organizationId, byName.get("Corrupt") ?? {}),
    ).resolves.toHaveLength(4);
  });

  it("commits engagement, suppression, and both timelines atomically and idempotently", async () => {
    const migrated = await migratedRuntime("crm-engagement-effects");
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CrmRepository(database);
    const sourced = await database
      .prepare(
        "SELECT contact_id FROM crm_contact_events WHERE event_id=? ORDER BY contact_id LIMIT 1",
      )
      .bind(eventId)
      .all<{ contact_id: string }>();
    const sourcedContactId = sourced.results?.[0]?.contact_id;
    if (!sourcedContactId) throw new Error("The seeded event needs a sourced CRM contact");
    const engagement = {
      id: "75000000-0000-4000-8000-0000000000f1",
      organizationId,
      eventId,
      campaignId: null,
      contactId: sourcedContactId,
      kind: "unsubscribed" as const,
      providerRef: "provider-unsubscribe-atomic",
      occurredAt: "2026-08-11T12:00:00.000Z",
      metadata: {},
    };
    const contactActivity = {
      id: "unused-contact-id",
      kind: "email" as const,
      summary: "Unsubscribed outreach",
      private: false,
      occurredAt: engagement.occurredAt,
      actorId: "missing-user",
    };
    const prospectActivity = {
      id: "unused-prospect-id",
      kind: "engagement" as const,
      summary: "Unsubscribed outreach",
      private: false,
      occurredAt: engagement.occurredAt,
      actorId: "missing-user",
    };

    await expect(
      repository.saveEngagement(engagement, contactActivity, prospectActivity),
    ).rejects.toThrow();
    const beforeRetry = await database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM crm_engagements WHERE id=?) AS engagements,(SELECT COUNT(*) FROM crm_contact_suppressions WHERE contact_id=?) AS suppressions",
      )
      .bind(engagement.id, sourcedContactId)
      .all<{ engagements: number; suppressions: number }>();
    expect(beforeRetry.results?.[0]).toEqual({ engagements: 0, suppressions: 0 });

    const validContact = { ...contactActivity, actorId: "seed-organizer" };
    const validProspect = { ...prospectActivity, actorId: "seed-organizer" };
    await expect(repository.saveEngagement(engagement, validContact, validProspect)).resolves.toBe(
      true,
    );
    await expect(repository.saveEngagement(engagement, validContact, validProspect)).resolves.toBe(
      false,
    );
    const effects = await database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM crm_engagements WHERE id=?) AS engagements,(SELECT COUNT(*) FROM crm_contact_suppressions WHERE contact_id=?) AS suppressions,(SELECT COUNT(*) FROM crm_contact_activities WHERE id='crm-engagement-contact:' || ?) AS contactActivities,(SELECT COUNT(*) FROM crm_activities WHERE id='crm-engagement-prospect:' || ?) AS prospectActivities",
      )
      .bind(engagement.id, sourcedContactId, engagement.id, engagement.id)
      .all<{
        engagements: number;
        suppressions: number;
        contactActivities: number;
        prospectActivities: number;
      }>();
    expect(effects.results?.[0]).toEqual({
      engagements: 1,
      suppressions: 1,
      contactActivities: 1,
      prospectActivities: 1,
    });
  });
});

/**
 * `1502` drops the stage CHECK by rebuilding `crm_prospects`, which has three children.
 *
 * The hazard `d1-migration-rebuild.integration.test.ts` records for `1703`, one table wider:
 * `crm_contacts`, `crm_activities` and `crm_contact_events` all carry a foreign key to the
 * prospect being dropped, and D1 checks the DROP with foreign keys on however the migration asks.
 *
 * `createMigratedDatabase` applies the migrations and *then* the seed, so the rebuild the suite
 * already ran copied empty tables. Replaying it over the seeded fixture is the only arrangement
 * where the copy and the drop meet rows in all four tables — the arrangement #134 asked for, and
 * the reason `1501` and `1502` are separate files: a migration that also creates tables cannot be
 * applied twice to check.
 */
describe("crm_prospects rebuild", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("replays over a database already holding prospects, contacts, activities and links", async () => {
    const migrated = await createMigratedDatabase({ label: "rebuild-crm-pipeline", seed: true });
    runtime = migrated.runtime;

    const counts = async () =>
      (
        await migrated.database
          .prepare(
            `SELECT (SELECT COUNT(*) FROM crm_prospects) AS prospects,
                    (SELECT COUNT(*) FROM crm_contacts) AS contacts,
                    (SELECT COUNT(*) FROM crm_activities) AS activities,
                    (SELECT COUNT(*) FROM crm_contact_events) AS links,
                    (SELECT COUNT(*) FROM crm_contacts c
                       JOIN crm_prospects p ON p.id = c.prospect_id) AS joinedContacts,
                    (SELECT COUNT(*) FROM crm_contact_events e
                       JOIN crm_prospects p ON p.id = e.prospect_id) AS joinedLinks`,
          )
          .all<{
            prospects: number;
            contacts: number;
            activities: number;
            links: number;
            joinedContacts: number;
            joinedLinks: number;
          }>()
      ).results?.[0];

    // If the fixture were empty this would prove nothing, so it is asserted rather than assumed.
    const before = await counts();
    expect(before?.prospects).toBeGreaterThan(0);
    expect(before?.contacts).toBeGreaterThan(0);
    expect(before?.activities).toBeGreaterThan(0);
    expect(before?.links).toBeGreaterThan(0);

    // A later migration owns a trigger whose body reads the table this historical migration
    // rebuilds. Production never reapplies 1502 after 1503, but this replay test deliberately
    // does; set the later schema object aside, then restore it exactly as migration ordering does.
    await migrated.database.prepare("DROP TRIGGER crm_pipeline_stage_no_stranded_prospects").run();
    await applyMigrationFile(migrated.database, "1502_crm_prospect_stage_rebuild.sql");
    await applyMigrationFile(migrated.database, "1503_crm_pipeline_stage_delete_guard.sql");

    // Every row survives, and every child still points at the prospect it did.
    const after = await counts();
    expect(after?.prospects).toBe(before?.prospects);
    expect(after?.contacts).toBe(before?.contacts);
    expect(after?.activities).toBe(before?.activities);
    expect(after?.links).toBe(before?.links);
    expect(after?.joinedContacts).toBe(before?.contacts);
    expect(after?.joinedLinks).toBe(before?.links);

    // The CHECK is gone, which is the whole point: a configured stage key `0015` did not know is
    // storable. It is configured first because `1503` separately requires every current card
    // stage to remain on its event's board.
    await migrated.database
      .prepare(
        "INSERT INTO crm_pipeline_stages (id,event_id,key,label,category,sort_order,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        "15030000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
        "post-rebuild-custom",
        "Post-rebuild custom",
        "open",
        8,
        "2026-08-12T12:00:00.000Z",
      )
      .run();
    const custom = await migrated.database
      .prepare("UPDATE crm_prospects SET stage = ? WHERE id = ?")
      .bind("post-rebuild-custom", "50000000-0000-4000-8000-000000000001")
      .run();
    expect(custom.success).toBe(true);

    // And the rebuilt table still has its complete default stage set plus the one deliberately
    // configured here, which says the two migrations are separable rather than merely separate.
    const stages = await migrated.database
      .prepare("SELECT COUNT(*) AS total FROM crm_pipeline_stages WHERE event_id = ?")
      .bind("00000000-0000-4000-8000-000000000001")
      .all<{ total: number }>();
    expect(stages.results?.[0]?.total).toBe(9);
  });
});
