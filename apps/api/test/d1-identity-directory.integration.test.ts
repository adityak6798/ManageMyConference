// @acceptance ACC-IDENTITY-EVENTS
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import type { IdentityDatabasePort } from "../src/adapters/persistence/d1-identity-directory";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

describe("D1IdentityDirectory", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("uses migrated memberships and roles as the authorization source", async () => {
    const migrated = await createMigratedDatabase({ label: "identity", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;

    const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
    await expect(directory.findByPersona("organizer")).resolves.toMatchObject({
      organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
      eventAccess: expect.arrayContaining([
        {
          eventId: "00000000-0000-4000-8000-000000000001",
          role: "organizer",
          capabilities: expect.any(Set),
        },
      ]),
      capabilities: new Set([
        "events:read",
        "events:create",
        "communications:manage",
        "events:settings:read",
        "events:settings:update",
        "agenda:manage",
        "crm:manage",
        "content:read",
        "content:manage",
        "review:manage",
        "review:evaluate",
      ]),
    });
    await directory.grantOrganizer("00000000-0000-4000-8000-000000000002", "seed-reviewer");
    await expect(directory.findByPersona("reviewer")).resolves.toMatchObject({
      eventAccess: expect.arrayContaining([
        expect.objectContaining({
          eventId: "00000000-0000-4000-8000-000000000002",
          role: "organizer",
        }),
      ]),
      capabilities: new Set([
        "events:read",
        "communications:manage",
        "events:settings:read",
        "events:settings:update",
        "agenda:manage",
        "crm:manage",
        "content:read",
        "content:manage",
        "review:manage",
        "review:evaluate",
      ]),
    });

    await database
      .prepare("DELETE FROM event_roles WHERE user_id = ?")
      .bind("seed-organizer")
      .run();
    await database
      .prepare("DELETE FROM organization_memberships WHERE user_id = ?")
      .bind("seed-organizer")
      .run();
    await expect(directory.findByPersona("organizer")).resolves.toMatchObject({
      organizations: [],
      eventAccess: [],
      capabilities: new Set(),
    });
  });
});
