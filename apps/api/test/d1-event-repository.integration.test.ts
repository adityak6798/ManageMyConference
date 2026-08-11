// @acceptance ACC-HARNESS
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, applySeedData, createMigratedDatabase } from "./support/seeded-d1";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";

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
      repository.findById(event.id, {
        organizationIds: ["00000000-0000-4000-8000-000000000099"],
        eventIds: [],
      }),
    ).resolves.toBeNull();
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
