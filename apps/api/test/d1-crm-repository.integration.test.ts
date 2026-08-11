// @acceptance ACC-CRM
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CrmRepository } from "../src/adapters/persistence/d1-crm-repository";

const eventId = "00000000-0000-4000-8000-000000000001";
describe("D1 CRM persistence", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("atomically records one conversion activity under concurrency", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "crm-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const file of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
      "0005_cfp_snapshot_status.sql",
      "0006_review_workflow.sql",
      "0007_review_completion_conflict_guard.sql",
      "0008_review_conflict_completion_guard.sql",
      "0009_review_assignment_requires_plan.sql",
      "0010_review_plan_lock.sql",
      "0011_cfp_transition_status_guard.sql",
      "0012_cfp_status_in_use_guard.sql",
      "0013_cfp_submission_default_status.sql",
      "0014_content_speaker_portal.sql",
      "0015_crm_conversion.sql",
      "0016_crm_speaker_conversion.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      if (/^(000[789]|001[0-3])_/.test(file)) {
        await database.prepare(sql).run();
        continue;
      }
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
    const repository = new D1CrmRepository(database);
    const prospect = {
      id: "10000000-0000-4000-8000-000000000010",
      eventId,
      name: "Concurrent",
      stage: "contacted" as const,
      ownerId: "seed-organizer",
      nextAction: null,
      nextActionAt: null,
      contacts: [
        {
          id: "20000000-0000-4000-8000-000000000010",
          name: "Concurrent",
          email: "concurrent@example.test",
          isPrimary: true,
        },
      ],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    await repository.create(prospect);
    const activity = (id: string) => ({
      id,
      kind: "conversion" as const,
      summary: "Converted prospect to speaker",
      private: false,
      occurredAt: "2026-08-10T12:00:00.000Z",
      actorId: "seed-organizer",
    });
    const existingSpeakerId = "10000000-0000-4000-8000-000000000001";
    await database
      .prepare(
        "CREATE TRIGGER fail_conversion_activity BEFORE INSERT ON crm_activities WHEN NEW.kind='conversion' BEGIN SELECT RAISE(FAIL, 'injected audit failure'); END",
      )
      .run();
    await expect(
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000009"),
      ),
    ).rejects.toThrow();
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      speakerId: null,
      stage: "contacted",
    });
    await database.prepare("DROP TRIGGER fail_conversion_activity").run();
    const converted = await Promise.all([
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000010"),
      ),
      repository.recordConversion(
        eventId,
        prospect.id,
        existingSpeakerId,
        activity("30000000-0000-4000-8000-000000000011"),
      ),
    ]);
    expect(converted.map(({ speakerId }) => speakerId)).toEqual([
      existingSpeakerId,
      existingSpeakerId,
    ]);
    const activities = await database
      .prepare("SELECT id FROM crm_activities WHERE prospect_id=? AND kind='conversion'")
      .bind(prospect.id)
      .all();
    expect(activities.results).toHaveLength(1);
    const persisted = await repository.findById(eventId, prospect.id);
    if (!persisted) throw new Error("Converted prospect was not persisted");
    await expect(repository.update({ ...persisted, stage: "contacted" })).rejects.toThrow();
    await expect(repository.findById(eventId, prospect.id)).resolves.toMatchObject({
      stage: "converted",
      speakerId: existingSpeakerId,
    });
  });
});
