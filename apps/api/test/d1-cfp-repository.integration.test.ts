// @acceptance ACC-CFP
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1CfpRepository,
  type D1CfpDatabasePort,
} from "../src/adapters/persistence/d1-cfp-repository";
const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
describe("D1CfpRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("persists published snapshots and returns one durable submission for concurrent retries", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "cfp-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const migration of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
    const repository = new D1CfpRepository(database as D1CfpDatabasePort);
    const form = {
      eventId: "00000000-0000-4000-8000-000000000001",
      title: "CFP",
      description: "",
      fields: [
        {
          id: "title",
          type: "short_text" as const,
          label: "Title",
          guidance: "",
          required: true,
          options: [],
        },
      ],
      status: "open" as const,
      version: 1,
      publishedAt: "2026-08-10T00:00:00.000Z",
    };
    await repository.saveForm(form);
    await repository.savePublished(form, true);
    await expect(repository.findPublished(form.eventId)).resolves.toEqual(form);
    const proposal = {
      id: "00000000-0000-4000-8000-000000000111",
      eventId: form.eventId,
      cfpVersion: 1,
      idempotencyKey: "same-retry-key",
      answers: { title: "Talk" },
      submittedAt: "2026-08-10T01:00:00.000Z",
    };
    const [first, second] = await Promise.all([
      repository.createSubmission(proposal),
      repository.createSubmission({ ...proposal, id: "00000000-0000-4000-8000-000000000222" }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(proposal.id);
  });
});
