// @acceptance ACC-AGENDA
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

describe("D1AgendaRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("retries concurrent placement writes without losing either update", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "agenda-concurrency-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const migration of [
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
      "0017_agenda.sql",
      "0018_agenda_draft_revision.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      if (/^(000[789]|001[0-3])_/.test(migration)) {
        await database.prepare(sql).run();
        continue;
      }
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    const communicationsMigration = await readFile(
      new URL("../migrations/0019_communications_outbox.sql", import.meta.url),
      "utf8",
    );
    for (const statement of statements(communicationsMigration))
      await database.prepare(statement).run();
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
    const repository = new D1AgendaRepository(database, () => new Date("2026-08-10T22:00:00.000Z"));
    const eventId = "00000000-0000-4000-8000-000000000001";
    await Promise.all([
      repository.savePlacement(eventId, {
        id: "placement-concurrent-a",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-0900",
      }),
      repository.savePlacement(eventId, {
        id: "placement-concurrent-b",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-1000",
      }),
    ]);
    const ids = (await repository.getDraft(eventId))?.placements.map(({ id }) => id) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining(["placement-concurrent-a", "placement-concurrent-b"]),
    );
    const current = await repository.getDraft(eventId);
    if (!current) throw new Error("Agenda fixture is required");
    await Promise.all([
      repository.saveResources(eventId, {
        rooms: [...current.rooms, { id: "room-concurrent", name: "Concurrent room" }],
        tracks: current.tracks,
        slots: current.slots,
      }),
      repository.savePlacement(eventId, {
        id: "placement-concurrent-c",
        sessionId: "session-workshop",
        roomId: "room-lab",
        trackId: "track-practice",
        slotId: "slot-1000",
      }),
    ]);
    const afterResourceWrite = await repository.getDraft(eventId);
    expect(afterResourceWrite?.rooms).toContainEqual({
      id: "room-concurrent",
      name: "Concurrent room",
    });
    expect(afterResourceWrite?.placements.map(({ id }) => id)).toContain("placement-concurrent-c");
  });
});
