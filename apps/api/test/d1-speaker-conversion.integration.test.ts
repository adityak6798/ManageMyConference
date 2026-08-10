// @acceptance ACC-CRM
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";

describe("content speaker conversion", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("links CRM provenance to an existing event speaker with the same email", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "speaker-link-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const file of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_crm_conversion.sql",
      "0004_content_speaker_conversion.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      for (const statement of sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await database.prepare(statement).run();
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of reset
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await database.prepare(statement).run();
    const eventId = "00000000-0000-4000-8000-000000000001",
      speakerId = "40000000-0000-4000-8000-000000000001";
    await database
      .prepare("INSERT INTO speaker_profiles (id,event_id,name,email) VALUES (?,?,?,?)")
      .bind(speakerId, eventId, "Existing", "same@example.test")
      .run();
    const adapter = new D1SpeakerConversion(database, () => crypto.randomUUID()),
      command = {
        eventId,
        source: { kind: "crm-prospect" as const, id: "10000000-0000-4000-8000-000000000001" },
        name: "Existing",
        email: "same@example.test",
        actorId: "seed-organizer",
        occurredAt: "2026-08-10T12:00:00.000Z",
        correlationId: "speaker-link-test",
        idempotencyKey: "crm-conversion:link-test",
      };
    await expect(adapter.createOrLink(command)).resolves.toEqual({ speakerId });
    await expect(adapter.createOrLink(command)).resolves.toEqual({ speakerId });
    const racingSource = {
      kind: "crm-prospect" as const,
      id: "10000000-0000-4000-8000-000000000002",
    };
    const raced = await Promise.all([
      adapter.createOrLink({ ...command, source: racingSource, email: "race-one@example.test" }),
      adapter.createOrLink({ ...command, source: racingSource, email: "race-two@example.test" }),
    ]);
    expect(raced[0]?.speakerId).toBe(raced[1]?.speakerId);
  });
});
