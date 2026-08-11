// @acceptance ACC-CRM
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1CrmRepository } from "../src/adapters/persistence/d1-crm-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";

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
    const stageChange = {
      id: "30000000-0000-4000-8000-000000000020",
      kind: "stage-change" as const,
      summary: "identified → contacted",
      private: false,
      occurredAt: "2026-08-10T12:05:00.000Z",
      actorId: "seed-organizer",
    };
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
        activities: [stageChange, note],
      },
      [stageChange, note],
    );
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "contacted",
      activities: [
        { kind: "stage-change", summary: "identified → contacted", private: false },
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
    const refusedStageChange = {
      id: "30000000-0000-4000-8000-000000000022",
      kind: "stage-change" as const,
      summary: "contacted → engaged",
      private: false,
      occurredAt: "2026-08-10T12:10:00.000Z",
      actorId: "seed-organizer",
    };
    await expect(
      repository.update(
        {
          ...prospect,
          stage: "engaged",
          updatedAt: "2026-08-10T12:10:00.000Z",
          activities: [],
        },
        [refusedStageChange, { ...note, id: "30000000-0000-4000-8000-000000000023" }],
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

  it("scopes assignable prospect owners to one event and excludes speakers", async () => {
    const migrated = await migratedRuntime("crm-owner-eligibility");
    runtime = migrated.runtime;
    const database = migrated.database;
    const directory = new D1IdentityDirectory(database);

    // Seeded event one: an organizer who also reviews there, plus a reviewer. `seed-speaker`
    // holds only the speaker role, so it is not offered — the identity the live API used to
    // accept as a prospect owner.
    await expect(directory.listAssignableOwnersForEvent(eventId)).resolves.toEqual([
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
