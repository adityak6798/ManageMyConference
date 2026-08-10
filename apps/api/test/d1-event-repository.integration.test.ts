// @acceptance ACC-HARNESS
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";

describe("D1EventRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("round-trips an event against a real local D1 binding", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "greenroom-test" },
    });
    const database = await runtime.getD1Database("DB");
    const migration = await readFile(
      new URL("../migrations/0001_create_events.sql", import.meta.url),
      "utf8",
    );
    const migrated = await database.prepare(migration).run();
    expect(migrated.success).toBe(true);
    const repository = new D1EventRepository(database as D1DatabasePort);
    const event = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "D1 Summit",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    };
    await repository.create(event);
    await expect(repository.list()).resolves.toEqual([event]);
  });

  it("restores the exact deterministic seed when reset is applied twice", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "greenroom-reset-test" },
    });
    const database = await runtime.getD1Database("DB");
    const migration = await readFile(
      new URL("../migrations/0001_create_events.sql", import.meta.url),
      "utf8",
    );
    await database.prepare(migration).run();
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    const statements = reset
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of statements) await database.prepare(statement).run();
    }
    const repository = new D1EventRepository(database as D1DatabasePort);
    await expect(repository.list()).resolves.toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Greenroom Demo Summit",
        timezone: "America/Los_Angeles",
        createdAt: "2026-08-09T12:00:00.000Z",
      },
    ]);
  });
});
