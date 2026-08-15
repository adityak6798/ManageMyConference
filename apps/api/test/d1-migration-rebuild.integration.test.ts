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
  "1004_api_clients.sql": "populated identity audit replay below",
  // Both rebuild a closed CHECK list: `1005` admits a `custom` event role and three audit
  // actions, `1006` admits the `reports:pii` capability on two scope tables. Each preserves
  // every existing row by `INSERT … SELECT` and is replayed against the seeded database by
  // `d1-custom-roles.integration.test.ts`, which reads the audit rows the seed already wrote.
  "1005_custom_event_roles.sql": "seeded replay in the custom-roles D1 integration suite",
  "1006_reports_pii_capability.sql": "seeded replay in the custom-roles D1 integration suite",
  "1300_review_rounds.sql": "unsafe deployed history corrected forward by 1301",
  "1301_review_rounds_safe_rebuild.sql": "seeded replay in the review D1 integration suite",
  "1502_crm_prospect_stage_rebuild.sql": "seeded replay in the CRM D1 integration suite",
  "1703_delivery_domain_event_triggers.sql": "seeded replay below",
  "1705_delivery_proposal_submitted_trigger.sql": "seeded replay below",
  "1706_delivery_reviewer_reminder_trigger.sql": "seeded replay below",
  "1708_delivery_cfp_deadline_triggers.sql": "seeded replay below",
  "1802_publication_slug_reservations.sql": "creates and drops a transient audit table",
  "1903_capability_link_creator_lifecycle.sql":
    "populated replay in the capability-links D1 integration suite",
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

  /*
   * Migration `1705` is the same rebuild one value wider, from the CFP lane rather than a
   * communications one (issue #190). It gets its own replay for the reason the case above exists at
   * all: the ordering is what makes a rebuild survive a populated database, and a second migration
   * that copies the recipe is a second chance to get the ordering wrong.
   *
   * **It takes the row census from `sqlite_master`, not from a list**, and that is the whole lesson
   * of this case. The first draft of `1705` rebuilt the two children `1703` knew about and left
   * `calendar_invite_states` — added by `1704`, after `1703` — pointing at the table being dropped.
   * The case above could not see it, because the seed leaves that table empty and the assertion only
   * named the two tables the migration under test happened to rebuild. So the fixture here is built
   * from whichever tables *actually* reference the parent, and the test fails if any of them is
   * empty when the replay starts: a rebuild's test is worth only as much as the rows it runs against,
   * and the next migration to add a child gets caught by this rather than by a deployment.
   */
  it("widens the trigger vocabulary again over a populated database", async () => {
    const migrated = await createMigratedDatabase({ label: "rebuild-1705", seed: true });
    runtime = migrated.runtime;

    /*
     * Every table the runtime *resolves* a foreign key from, rather than every table whose stored
     * DDL happens to spell the parent's current name.
     *
     * `pragma_foreign_key_list` is the authority and the difference is not academic: after a
     * rebuild the children are created against `communication_deliveries_next` and the parent is
     * renamed over them, and whether the stored `CREATE TABLE` text is rewritten to match depends
     * on the SQLite build. It is not rewritten by the `sqlite3` CLI on this machine and it *is*
     * under workerd, so a `sqlite_master LIKE` scan finds three children in production and none in
     * a local check — which is the kind of disagreement a census must not be built on.
     */
    const parentsOf = async (table: string): Promise<{ parent: string; column: string }[]> => {
      // Two statements rather than a join: D1 refuses `sqlite_master JOIN pragma_foreign_key_list(…)`
      // with `SQLITE_AUTH`, so the table name is interpolated one at a time from the list below.
      const keys = await migrated.database
        .prepare(
          `SELECT "table" AS parent, "from" AS column FROM pragma_foreign_key_list('${table}')`,
        )
        .all<{ parent: string; column: string }>();
      return keys.results ?? [];
    };
    const tables = await migrated.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'communication_deliveries' ORDER BY name",
      )
      .all<{ name: string }>();
    const children: string[] = [];
    for (const { name } of tables.results ?? [])
      if ((await parentsOf(name)).some((key) => key.parent === "communication_deliveries"))
        children.push(name);
    // If this list is ever empty the test proves nothing, so it is asserted rather than assumed.
    expect(children).toEqual([
      "calendar_invite_states",
      "communication_attempts",
      "outbound_projection_state",
    ]);

    // The seed leaves `calendar_invite_states` empty, so the fixture supplies the row it lacks —
    // one calendar invite, pointing at a seeded delivery, exactly as a deployment that has sent one.
    await migrated.database
      .prepare(
        "INSERT INTO calendar_invite_states (organization_id, event_id, session_id, speaker_profile_id, schedule_ref, recipient_ref, sequence, delivery_id) SELECT organization_id, event_id, 'session-1', 'profile-1', 'schedule-1', recipient_ref, 3, id FROM communication_deliveries LIMIT 1",
      )
      .run();

    const census = async () => {
      const rows = await Promise.all(
        children.map((table) =>
          migrated.database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).all<{
            total: number;
          }>(),
        ),
      );
      const attempts = await migrated.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM communication_deliveries) AS deliveries, (SELECT COUNT(*) FROM communication_attempts a JOIN communication_deliveries d ON d.id = a.delivery_id) AS joined, (SELECT COUNT(*) FROM calendar_invite_states c JOIN communication_deliveries d ON d.id = c.delivery_id) AS invitesJoined",
        )
        .all<{ deliveries: number; joined: number; invitesJoined: number }>();
      return {
        ...Object.fromEntries(
          children.map((table, index) => [table, rows[index]?.results?.[0]?.total]),
        ),
        ...attempts.results?.[0],
      };
    };
    const before = await census();
    // Every child populated before the replay — the condition the first draft's failure needed.
    for (const table of children)
      expect({ table, rows: before[table] }).toEqual({ table, rows: expect.any(Number) });
    for (const table of children) expect(before[table]).toBeGreaterThan(0);

    await applyMigrationFile(migrated.database, "1705_delivery_proposal_submitted_trigger.sql");

    // Every row survives, and every child still resolves to the delivery it named.
    const after = await census();
    expect(after).toEqual(before);

    /*
     * And the foreign keys are still *live*, not merely still written down.
     *
     * A rebuild can leave a child pointing at a name that no longer exists, in which case the
     * constraint silently stops constraining — so this drives both directions through the child the
     * first draft of the migration forgot: a delivery id that does not exist must be refused, and a
     * real one must be accepted.
     */
    for (const table of children) {
      const resolved = (await parentsOf(table)).find((key) => key.column === "delivery_id");
      expect({ table, parent: resolved?.parent }).toEqual({
        table,
        parent: "communication_deliveries",
      });
    }
    await expect(
      migrated.database
        .prepare(
          "INSERT INTO calendar_invite_states (organization_id, event_id, session_id, speaker_profile_id, schedule_ref, recipient_ref, sequence, delivery_id) VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'dangling', 'p', 'r', 'a@b.test', 0, 'no-such-delivery')",
        )
        .run(),
    ).rejects.toThrow();

    // The value the CFP lane came for, and no widening beyond it.
    const submitted = await migrated.database
      .prepare(
        "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES ('rebuild-proposal', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'rebuild:proposal', 'proposal.submitted', 'email', NULL, NULL, 'pat@example.test', '{}', NULL, 'queued', 0, '2026-08-13T09:00:00.000Z', NULL, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z', 'Subject', 'Body')",
      )
      .run();
    expect(submitted.success).toBe(true);
    await expect(
      migrated.database
        .prepare(
          "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES ('rebuild-proposal-bogus', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'rebuild:proposal-bogus', 'proposal.withdrawn', 'email', NULL, NULL, 'pat@example.test', '{}', NULL, 'queued', 0, '2026-08-13T09:00:00.000Z', NULL, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z', 'Subject', 'Body')",
        )
        .run(),
    ).rejects.toThrow();

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

  it("replays 1708 over populated children and preserves main's reviewer reminder trigger", async () => {
    /*
     * The same replay for issue #210's rebuild. It is `1705`'s file with two more values in one
     * `CHECK`, which is exactly the shape that looks safe and is not: the drop of the parent is
     * refused the moment any child holds a row, and `calendar_invite_states` — the child a copy of
     * `1703` forgets — is empty in the seed. So it is populated first, deliberately.
     */
    const migrated = await createMigratedDatabase({ label: "rebuild-1708", seed: true });
    runtime = migrated.runtime;
    await migrated.database
      .prepare(
        "INSERT INTO calendar_invite_states (organization_id, event_id, session_id, speaker_profile_id, schedule_ref, recipient_ref, sequence, delivery_id) SELECT organization_id, event_id, 'session-1', 'profile-1', 'schedule-1', recipient_ref, 3, id FROM communication_deliveries LIMIT 1",
      )
      .run();
    const census = () =>
      migrated.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM communication_deliveries) AS deliveries, (SELECT COUNT(*) FROM communication_attempts a JOIN communication_deliveries d ON d.id = a.delivery_id) AS joined, (SELECT COUNT(*) FROM outbound_projection_state) AS projections, (SELECT COUNT(*) FROM calendar_invite_states c JOIN communication_deliveries d ON d.id = c.delivery_id) AS invitesJoined",
        )
        .all<{
          deliveries: number;
          joined: number;
          projections: number;
          invitesJoined: number;
        }>();
    const before = (await census()).results?.[0];
    for (const total of Object.values(before ?? {})) expect(total).toBeGreaterThan(0);

    await applyMigrationFile(migrated.database, "1708_delivery_cfp_deadline_triggers.sql");

    // Every row survives, and every child still resolves to the delivery it named.
    expect((await census()).results?.[0]).toEqual(before);

    const insert = (id: string, trigger: string) =>
      migrated.database
        .prepare(
          `INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES ('${id}', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', '${id}', '${trigger}', 'email', NULL, NULL, 'pat@example.test', '{}', NULL, 'queued', 0, '2026-08-14T09:00:00.000Z', NULL, '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', 'Subject', 'Body')`,
        )
        .run();

    // The two values the lane came for…
    await expect(insert("rebuild-deadline", "cfp.deadline_approaching")).resolves.toMatchObject({
      success: true,
    });
    await expect(insert("rebuild-closed", "cfp.call_closed")).resolves.toMatchObject({
      success: true,
    });
    // …a value that predates them, still admitted…
    await expect(insert("rebuild-kept", "proposal.submitted")).resolves.toMatchObject({
      success: true,
    });
    // …and the trigger admitted by main's immediately preceding rebuild remains admitted.
    await expect(insert("rebuild-reviewer-reminder", "reviewer.reminder")).resolves.toMatchObject({
      success: true,
    });
    // …and no widening beyond them.
    await expect(insert("rebuild-bogus", "cfp.deadline_missed")).rejects.toThrow();
  });
});
