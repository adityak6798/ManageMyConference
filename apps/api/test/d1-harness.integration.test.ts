// @acceptance ACC-HARNESS
/**
 * The shared D1 harness, tested on its own.
 *
 * Every other integration test leans on it, so the properties it promises — one canonical
 * migration order, triggers that actually execute, an isolated database per call, a
 * deterministic seed that can be applied twice — are asserted here rather than assumed
 * everywhere.
 *
 * The assertions are deliberately schema-neutral: they read `sqlite_schema` and count rows
 * across whatever tables exist, and name no domain's table anywhere. The harness is generic,
 * so its test is too — which is also why it does not reach across an ownership boundary to
 * make its point, and why it needs no edit when a domain adds a table.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  applySeedData,
  createMigratedDatabase,
  type MigratedDatabase,
  migrationFilenames,
} from "./support/seeded-d1";

type Database = MigratedDatabase["database"];

/**
 * Objects this repository's migrations created.
 *
 * `sqlite_%`, `d1_%` and `_cf_%` are the runtime's own bookkeeping — D1 refuses to query them
 * at all, answering `SQLITE_AUTH` — so they are excluded rather than counted.
 */
const objectsOfType = async (database: Database, type: "table" | "trigger") =>
  (
    await database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = ?1 AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
      )
      .bind(type)
      .all()
  ).results.map((row: unknown) => String((row as { name: unknown }).name));

/** Total rows across every user table, without naming any of them. */
async function totalRows(database: Database): Promise<number> {
  let total = 0;
  for (const table of await objectsOfType(database, "table")) {
    const row = await database.prepare(`SELECT COUNT(*) AS tally FROM "${table}"`).first();
    total += Number((row as { tally: unknown }).tally);
  }
  return total;
}

describe("the shared D1 integration harness", () => {
  const open: MigratedDatabase[] = [];
  const create = async (options: Parameters<typeof createMigratedDatabase>[0] = {}) => {
    const migrated = await createMigratedDatabase(options);
    open.push(migrated);
    return migrated;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((migrated) => migrated.dispose()));
  });

  it("applies every migration in the directory, in canonical filename order", async () => {
    const migrated = await create({ label: "harness-order" });
    expect(migrated.applied).toEqual(await migrationFilenames());
    expect(migrated.applied).toEqual([...migrated.applied].sort());
    // Not a hand-maintained subset: whatever is in the directory is what was applied.
    expect(migrated.applied.length).toBeGreaterThan(20);
  });

  it("executes migrations whose bodies contain triggers", async () => {
    const migrated = await create({ label: "harness-triggers" });
    // A naive `split(";")` cuts a trigger body in half at the semicolon between BEGIN and
    // END, and the fragments either fail or silently create nothing. Both used to happen.
    expect((await objectsOfType(migrated.database, "trigger")).length).toBeGreaterThan(0);
  });

  it("gives a migrated database its schema, and a seeded one the fixture on top", async () => {
    const migratedOnly = await create({ label: "harness-clean" });
    expect((await objectsOfType(migratedOnly.database, "table")).length).toBeGreaterThan(20);
    // Not zero: a few migrations backfill rows of their own, and that is part of what
    // "migrated" means here. What matters is that none of the *seed* fixture is present.
    const baseline = await totalRows(migratedOnly.database);

    const seeded = await create({ label: "harness-seeded", seed: true });
    expect(await totalRows(seeded.database)).toBeGreaterThan(baseline);
  });

  it("applies the seed twice with an identical result", async () => {
    const migrated = await create({ label: "harness-idempotent", seed: true });
    const afterFirst = await totalRows(migrated.database);
    await applySeedData(migrated.database);
    expect(await totalRows(migrated.database)).toBe(afterFirst);
    await applySeedData(migrated.database);
    expect(await totalRows(migrated.database)).toBe(afterFirst);
  });

  it("isolates each database, so one test cannot see another's rows", async () => {
    const seeded = await create({ label: "harness-isolation", seed: true });
    const clean = await create({ label: "harness-isolation" });
    // Same label, same migrations, separate databases: the seed applied to one is invisible
    // to the other, which would not be true of a shared file.
    expect(await totalRows(seeded.database)).toBeGreaterThan(await totalRows(clean.database));
  });

  it("stops at an explicit old-schema fixture only when asked", async () => {
    const partial = await create({
      label: "harness-through",
      through: "0001_create_events.sql",
    });
    const full = await create({ label: "harness-full" });
    expect(partial.applied).toEqual(["0001_create_events.sql"]);
    const early = await objectsOfType(partial.database, "table");
    const complete = await objectsOfType(full.database, "table");
    // The later tables genuinely are absent, which is what makes it a migration-compatibility
    // fixture rather than a shortcut.
    expect(early.length).toBeLessThan(complete.length);
    expect(complete).toEqual(expect.arrayContaining(early));
  });

  it("names the migration and the statement when one fails", async () => {
    const migrated = await create({ label: "harness-failure" });
    // Applying 0002 a second time re-creates a table that already exists.
    await expect(
      applyMigrations(migrated.database, {
        from: "0002_identity_event_foundation.sql",
        through: "0002_identity_event_foundation.sql",
      }),
    ).rejects.toThrow(/0002_identity_event_foundation\.sql: statement \d+ failed/);
  });

  it("refuses a migration name that does not exist rather than silently applying none", async () => {
    const migrated = await create({ label: "harness-unknown" });
    await expect(
      applyMigrations(migrated.database, { through: "9999_not_a_migration.sql" }),
    ).rejects.toThrow(/names a migration that does not exist/);
  });
});

/*
 * How many round trips building a database costs.
 *
 * Every call on a real D1 database is an HTTP request to the workerd process over a fresh TCP
 * connection. When the harness ran each statement on its own, one database cost ~180 sockets and
 * a suite of eighty exhausted macOS's entire ephemeral range, so tests failed on `EADDRNOTAVAIL`
 * with messages that read like schema faults (`GAP-017`). This is asserted against a double
 * rather than by counting sockets, because the property that matters — the statements go in one
 * batch — is the same on every operating system, and the socket count is not.
 */
describe("the cost of building a database", () => {
  /** Records how it was called, and answers enough for the harness to proceed. */
  function recorder(options: { batch: boolean }) {
    const calls = { prepared: 0, ran: 0, batched: 0, batchSizes: [] as number[] };
    const database = {
      prepare(sql: string) {
        calls.prepared += 1;
        return {
          sql,
          run: async () => {
            calls.ran += 1;
          },
        };
      },
      ...(options.batch
        ? {
            batch: async (prepared: unknown[]) => {
              calls.batched += 1;
              calls.batchSizes.push(prepared.length);
            },
          }
        : {}),
    };
    return { database, calls };
  }

  it("sends every migration in one batch when the database offers one", async () => {
    const { database, calls } = recorder({ batch: true });

    const applied = await applyMigrations(database as never);

    expect(applied.length).toBeGreaterThan(20);
    // One round trip for the whole set, whatever the migration count grows to.
    expect(calls.batched).toBe(1);
    expect(calls.ran).toBe(0);
    expect(calls.batchSizes[0]).toBe(calls.prepared);
  });

  it("falls back to one statement at a time when it does not", async () => {
    // The schema drift tool applies these migrations to a synchronous `node:sqlite` handle,
    // which has no `batch`. The harness has to keep working there.
    const { database, calls } = recorder({ batch: false });

    await applyMigrations(database as never);

    expect(calls.batched).toBe(0);
    expect(calls.ran).toBe(calls.prepared);
    expect(calls.ran).toBeGreaterThan(100);
  });

  it("seeds in one batch too", async () => {
    const { database, calls } = recorder({ batch: true });

    await applySeedData(database as never);

    expect(calls.batched).toBe(1);
    expect(calls.ran).toBe(0);
  });
});
