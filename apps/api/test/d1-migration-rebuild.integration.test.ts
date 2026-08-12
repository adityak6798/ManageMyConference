// @acceptance ACC-INTEGRATION
/*
 * Migration 1703 rebuilds `communication_deliveries`, and a rebuild is the one migration shape
 * whose test can be green while the migration cannot run at all.
 *
 * `createMigratedDatabase` applies the migrations and *then* the seed, so every rebuild in the
 * suite copies an empty table and drops a table nothing references yet. A deployed database has
 * rows in `communication_attempts` and `outbound_projection_state`, both of which carry a foreign
 * key to the table being dropped — and D1 does not honour `PRAGMA foreign_keys = OFF` between
 * statements, so the DROP is checked with foreign keys on and refused.
 *
 * This applies the migration a second time over the seeded fixture, which is the only arrangement
 * that exercises the copy and the drop with rows present in all three tables.
 */
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrationFile,
  createMigratedDatabase,
  migrationFilenames,
} from "./support/seeded-d1";

const rebuildCoverage = {
  "0002_identity_event_foundation.sql": "foundational rename drops its private old table",
  "1300_review_rounds.sql": "unsafe deployed history corrected forward by 1301",
  "1301_review_rounds_safe_rebuild.sql": "seeded replay in the review D1 integration suite",
  "1703_delivery_domain_event_triggers.sql": "seeded replay below",
  "1802_publication_slug_reservations.sql": "creates and drops a transient audit table",
} as const;

describe("migration rebuild coverage", () => {
  it("requires every migration containing DROP TABLE to declare its populated-data disposition", async () => {
    const migrations = await migrationFilenames();
    const dropping: string[] = [];
    for (const name of migrations) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      if (/\bDROP\s+TABLE\b/i.test(sql)) dropping.push(name);
    }
    expect(dropping).toEqual(Object.keys(rebuildCoverage).sort());
  });
});

describe("communication_deliveries rebuild", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("runs against a database that already holds deliveries, attempts and projections", async () => {
    const migrated = await createMigratedDatabase({ label: "rebuild-populated", seed: true });
    runtime = migrated.runtime;

    // The seed leaves four deliveries, three attempts and one projection row. If any of that were
    // absent this test would prove nothing, so it is asserted rather than assumed.
    const before = await migrated.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM communication_deliveries) AS deliveries, (SELECT COUNT(*) FROM communication_attempts) AS attempts, (SELECT COUNT(*) FROM outbound_projection_state) AS projections",
      )
      .all<{ deliveries: number; attempts: number; projections: number }>();
    expect(before.results?.[0]?.deliveries).toBeGreaterThan(0);
    expect(before.results?.[0]?.attempts).toBeGreaterThan(0);
    expect(before.results?.[0]?.projections).toBeGreaterThan(0);

    await applyMigrationFile(migrated.database, "1703_delivery_domain_event_triggers.sql");

    // Every row survives the rebuild, and the children still point at the deliveries they did.
    const after = await migrated.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM communication_deliveries) AS deliveries, (SELECT COUNT(*) FROM communication_attempts) AS attempts, (SELECT COUNT(*) FROM outbound_projection_state) AS projections, (SELECT COUNT(*) FROM communication_attempts a JOIN communication_deliveries d ON d.id = a.delivery_id) AS joined",
      )
      .all<{ deliveries: number; attempts: number; projections: number; joined: number }>();
    expect(after.results?.[0]).toEqual({
      ...before.results?.[0],
      joined: before.results?.[0]?.attempts,
    });

    // The widened constraint is the point of the migration: the trigger values it admits insert,
    // and a value nobody agreed on still does not.
    const accepted = await migrated.database
      .prepare(
        "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES ('rebuild-invite', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'rebuild:invite', 'speaker.calendar_invite', 'email', NULL, NULL, 'ada@example.test', '{}', NULL, 'queued', 0, '2026-08-12T09:00:00.000Z', NULL, '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z', 'Subject', 'Body')",
      )
      .run();
    expect(accepted.success).toBe(true);
    await expect(
      migrated.database
        .prepare(
          "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES ('rebuild-bogus', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'rebuild:bogus', 'speaker.telepathy', 'email', NULL, NULL, 'ada@example.test', '{}', NULL, 'queued', 0, '2026-08-12T09:00:00.000Z', NULL, '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z', 'Subject', 'Body')",
        )
        .run(),
    ).rejects.toThrow();

    // The indexes the outbox leases through have to come back, or every drain degrades to a scan.
    const indexes = await migrated.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
      .bind("communication_deliveries")
      .all<{ name: string }>();
    expect((indexes.results ?? []).map((index: { name: string }) => index.name)).toEqual(
      expect.arrayContaining([
        "communication_deliveries_event_idx",
        "communication_deliveries_worker_idx",
      ]),
    );
  });
});
