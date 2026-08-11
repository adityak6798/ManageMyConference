// @acceptance ACC-PUBLIC
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1PublicationRepository } from "../src/adapters/persistence/d1-publication-repository";
import { PublicationService } from "../src/application/publishing/publication-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
const safeProjection = {
  event: {
    slug: "safe-event",
    name: "Safe Event",
    summary: "Public summary",
    startsOn: "2026-09-01",
    endsOn: "2026-09-02",
    timezone: "UTC",
    venue: "Online",
  },
  cfp: {
    title: "CFP",
    description: "Join",
    status: "open" as const,
    publishedAt: "2026-08-01T00:00:00.000Z",
    submissionUrl: "https://example.com/cfp",
  },
  sessions: [],
  speakers: [],
};

describe("D1PublicationRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("stores only allowlisted fields when publishing a contaminated draft", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const name of [
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
      "0019_communications_outbox.sql",
      "0020_public_event_projections.sql",
    ]) {
      const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      if (/^(000[789]|001[0-3])_/.test(name)) {
        await database.prepare(migration).run();
        continue;
      }
      for (const statement of statements(migration)) await database.prepare(statement).run();
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
    const draft = {
      ...safeProjection,
      crmNotes: "private CRM",
      speakers: [
        {
          slug: "speaker",
          name: "Speaker",
          bio: "Public",
          headline: "Builder",
          privateEmail: "private@example.com",
        },
      ],
    };
    await database
      .prepare(
        "UPDATE public_event_projections SET state = 'draft', draft_json = ?, published_json = NULL, published_at = NULL WHERE event_id = ?",
      )
      .bind(JSON.stringify(draft), "00000000-0000-4000-8000-000000000001")
      .run();
    const service = new PublicationService(
      new D1PublicationRepository(database),
      () => new Date("2026-08-10T00:00:00.000Z"),
    );
    await service.publish(
      await resolveSeededDemoActor("organizer"),
      "00000000-0000-4000-8000-000000000001",
    );
    const stored = await database
      .prepare("SELECT published_json FROM public_event_projections WHERE event_id = ?")
      .bind("00000000-0000-4000-8000-000000000001")
      .first<{ published_json: string }>();
    expect(stored).not.toBeNull();
    expect(stored?.published_json).not.toMatch(
      /crmNotes|private CRM|privateEmail|private@example.com/,
    );
    expect(JSON.parse(stored?.published_json ?? "{}")).toMatchObject({
      event: { name: "Safe Event" },
      speakers: [{ name: "Speaker" }],
    });
  });
});
