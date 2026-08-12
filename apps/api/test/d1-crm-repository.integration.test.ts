// @acceptance ACC-CRM
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CrmRepository } from "../src/adapters/persistence/d1-crm-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import {
  ContactAlreadySourcedError,
  ContactEmailTakenError,
  ContactNotFoundError,
} from "../src/application/crm/errors";
import { createMigratedDatabase } from "./support/seeded-d1";

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
});
