// @acceptance ACC-IDENTITY-EVENTS
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
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
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "identity-test" },
    });
    const database = await runtime.getD1Database("DB");
    const initial = await readFile(
      new URL("../migrations/0001_create_events.sql", import.meta.url),
      "utf8",
    );
    await database.prepare(initial).run();
    const foundation = await readFile(
      new URL("../migrations/0002_identity_event_foundation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of statements(foundation)) await database.prepare(statement).run();
    for (const file of [
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
      "0005_cfp_snapshot_status.sql",
      "0006_review_workflow.sql",
    ]) {
      const migrationSql = await readFile(
        new URL(`../migrations/${file}`, import.meta.url),
        "utf8",
      );
      for (const statement of statements(migrationSql)) await database.prepare(statement).run();
    }
    for (const file of [
      "0007_review_completion_conflict_guard.sql",
      "0008_review_conflict_completion_guard.sql",
      "0009_review_assignment_requires_plan.sql",
      "0010_review_plan_lock.sql",
      "0011_cfp_transition_status_guard.sql",
      "0012_cfp_status_in_use_guard.sql",
      "0013_cfp_submission_default_status.sql",
    ]) {
      const trigger = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      expect((await database.prepare(trigger).run()).success).toBe(true);
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();

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
      capabilities: new Set(["events:read", "events:create"]),
    });
    await directory.grantOrganizer("00000000-0000-4000-8000-000000000002", "seed-reviewer");
    await expect(directory.findByPersona("reviewer")).resolves.toMatchObject({
      eventAccess: expect.arrayContaining([
        expect.objectContaining({
          eventId: "00000000-0000-4000-8000-000000000002",
          role: "organizer",
        }),
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
