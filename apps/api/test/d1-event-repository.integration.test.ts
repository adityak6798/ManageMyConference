// @acceptance ACC-HARNESS
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import {
  D1IdentityDirectory,
  preparedOrganizerGrant,
} from "../src/adapters/persistence/d1-identity-directory";
import { applyMigrations, applySeedData, createMigratedDatabase } from "./support/seeded-d1";

describe("D1EventRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("round-trips an event against a real local D1 binding", async () => {
    // A deliberate old-schema fixture: this case exists to prove that 0002 preserves rows
    // written under 0001, so it is the one test that must not take the whole migration set.
    const migrated = await createMigratedDatabase({
      label: "greenroom-migration-compatibility",
      through: "0001_create_events.sql",
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    await database
      .prepare("INSERT INTO events (id, name, timezone, created_at) VALUES (?, ?, ?, ?)")
      .bind(
        "023e4567-e89b-42d3-a456-426614174000",
        "Existing Summit",
        "UTC",
        "2026-08-08T12:00:00.000Z",
      )
      .run();
    await applyMigrations(database, { from: "0002_identity_event_foundation.sql" });
    const repository = new D1EventRepository(database as D1DatabasePort);
    await expect(
      repository.list({
        organizationIds: ["00000000-0000-4000-8000-000000000000"],
        eventIds: [],
      }),
    ).resolves.toEqual([
      {
        id: "023e4567-e89b-42d3-a456-426614174000",
        organizationId: "00000000-0000-4000-8000-000000000000",
        name: "Existing Summit",
        timezone: "UTC",
        createdAt: "2026-08-08T12:00:00.000Z",
      },
    ]);
    const event = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "D1 Summit",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    };
    await database
      .prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
      .bind(event.organizationId, "Test Org", event.createdAt)
      .run();
    await repository.create(event);
    await expect(
      repository.list({ organizationIds: [event.organizationId], eventIds: [] }),
    ).resolves.toEqual([event]);
    await expect(
      repository.findById(event.id, { organizationIds: [event.organizationId], eventIds: [] }),
    ).resolves.toEqual(event);
    await expect(
      repository.update(event.id, "Renamed Summit", "America/New_York"),
    ).resolves.toEqual({ ...event, name: "Renamed Summit", timezone: "America/New_York" });
    await expect(
      repository.findById(event.id, {
        organizationIds: ["00000000-0000-4000-8000-000000000099"],
        eventIds: [],
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listIdsInOrganization(event.organizationId, [
        "023e4567-e89b-42d3-a456-426614174000",
        event.id,
        "missing",
        ...Array.from({ length: 1_000 }, (_, index) => `missing-${index}`),
      ]),
    ).resolves.toEqual([event.id]);
  });

  /**
   * The three writes issue #164 turns on, against the storage that decides them.
   *
   * A provisioning key that is taken is a refusal from SQLite rather than a check this adapter
   * performs, the organizer grant lands in the same batch as the row it belongs to, and an
   * organization is discarded only while it holds nothing. Each is asserted by its effect on the
   * tables, because a service-level fake would agree with whatever this file did.
   */
  it("refuses a second provisioning of one organization, and commits the grant with the row", async () => {
    const migrated = await createMigratedDatabase({ label: "greenroom-provisioning", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1EventRepository(database as D1DatabasePort, preparedOrganizerGrant);
    const organizationId = "00000000-0000-4000-8000-000000000010";
    const base = {
      organizationId,
      timezone: "UTC",
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    const first = { ...base, id: "10000000-0000-4000-8000-00000000aaa1", name: "First" };
    const second = { ...base, id: "10000000-0000-4000-8000-00000000aaa2", name: "Second" };

    await expect(
      repository.create(first, {
        provisioningKey: "self-serve-first-event",
        organizerUserId: "seed-organizer",
      }),
    ).resolves.toBe("created");
    // The second writer loses on the index rather than on anything this code checked first.
    await expect(
      repository.create(second, {
        provisioningKey: "self-serve-first-event",
        organizerUserId: "seed-organizer",
      }),
    ).resolves.toBe("provisioning-key-taken");
    await expect(
      repository.findByProvisioningKey(organizationId, "self-serve-first-event"),
    ).resolves.toMatchObject({ id: first.id });
    await expect(
      repository.findByProvisioningKey(organizationId, "no-such-key"),
    ).resolves.toBeNull();

    /*
     * The refused insert took its grant with it: no role for an event that was never written.
     *
     * Read through identity's directory rather than by querying `event_roles`, which belongs to
     * that domain — this file is the events domain's, and the grant travels through its writer
     * precisely so this domain never learns the table.
     */
    const identity = new D1IdentityDirectory(
      database as ConstructorParameters<typeof D1IdentityDirectory>[0],
    );
    await expect(identity.listAssignableOwnersForEvent(first.id)).resolves.toEqual([
      { id: "seed-organizer", name: "Olivia Organizer" },
    ]);
    await expect(identity.listAssignableOwnersForEvent(second.id)).resolves.toEqual([]);

    // An unkeyed create is unaffected by the index, however many an organization already has.
    await expect(
      repository.create({ ...base, id: "10000000-0000-4000-8000-00000000aaa3", name: "Third" }),
    ).resolves.toBe("created");
    await expect(
      repository.create({ ...base, id: "10000000-0000-4000-8000-00000000aaa4", name: "Fourth" }),
    ).resolves.toBe("created");

    // A grant with nothing bound to write it is refused rather than silently skipped, because an
    // event whose creator holds no role on it is the defect this batching exists to prevent.
    await expect(
      new D1EventRepository(database as D1DatabasePort).create(
        { ...base, id: "10000000-0000-4000-8000-00000000aaa5", name: "Ungranted" },
        { organizerUserId: "seed-organizer" },
      ),
    ).rejects.toThrow(/organizer grant writer/);
  });

  it("discards an organization nothing references, and keeps one that is in use", async () => {
    const migrated = await createMigratedDatabase({ label: "greenroom-orphans", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1EventRepository(database as D1DatabasePort);
    const orphan = { id: "20000000-0000-4000-8000-00000000bbb1", name: "Abandoned signup" };

    await repository.createOrganization({ ...orphan, createdAt: "2026-08-12T12:00:00.000Z" });
    await expect(repository.discardUnusedOrganization(orphan.id)).resolves.toBe(true);
    // Reporting the count rather than assuming it: a second discard removed nothing.
    await expect(repository.discardUnusedOrganization(orphan.id)).resolves.toBe(false);
    await expect(
      repository.discardUnusedOrganization("00000000-0000-4000-8000-000000000010"),
    ).resolves.toBe(false);
    // The seeded organization that holds events is still there, with its events.
    await expect(
      repository.listAllIdsInOrganization("00000000-0000-4000-8000-000000000010"),
    ).resolves.toHaveLength(2);

    /*
     * The other half of the guard: an organization holding no events but an event *template*.
     * Both predicates are this domain's own tables, and only one of them was exercised — a
     * template is a captured configuration somebody saved, so discarding the organization out
     * from under it is the same loss in a quieter form.
     */
    const templated = { id: "20000000-0000-4000-8000-00000000bbb2", name: "Templates only" };
    await repository.createOrganization({ ...templated, createdAt: "2026-08-12T12:00:00.000Z" });
    await database
      .prepare(
        "INSERT INTO event_templates (id, organization_id, name, state, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      )
      .bind(
        "20000000-0000-4000-8000-00000000bbb3",
        templated.id,
        "Saved starter",
        "2026-08-12T12:00:00.000Z",
        "2026-08-12T12:00:00.000Z",
      )
      .run();
    await expect(repository.discardUnusedOrganization(templated.id)).resolves.toBe(false);
  });

  it("restores the exact deterministic seed when reset is applied twice", async () => {
    const migrated = await createMigratedDatabase({ label: "greenroom-reset" });
    runtime = migrated.runtime;
    const database = migrated.database;
    // Twice on purpose: the reset has to be idempotent, so the second application must
    // land on the state the first one produced and leave it identical.
    for (let attempt = 0; attempt < 2; attempt += 1) await applySeedData(database);
    const repository = new D1EventRepository(database as D1DatabasePort);
    await expect(
      repository.list({ organizationIds: ["00000000-0000-4000-8000-000000000010"], eventIds: [] }),
    ).resolves.toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Greenroom Demo Summit",
        timezone: "America/Los_Angeles",
        createdAt: "2026-08-09T12:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Greenroom Workshop Day",
        timezone: "America/New_York",
        createdAt: "2026-08-10T12:00:00.000Z",
      },
    ]);
  });
});
