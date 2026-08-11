// @acceptance ACC-CRM
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";

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
    const eventId = "00000000-0000-4000-8000-000000000001",
      speakerId = "40000000-0000-4000-8000-000000000001";
    await database
      .prepare(
        "INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES (?,?,?,?,?,?,?,?,?,NULL)",
      )
      .bind(
        speakerId,
        eventId,
        "seed-public",
        "existing-person",
        "Existing",
        "same@example.test",
        "",
        "",
        "",
      )
      .run();
    const identityDirectory = new D1IdentityDirectory(database),
      adapter = new D1SpeakerConversion(database, () => crypto.randomUUID(), identityDirectory),
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
    const sameSourceProfiles = await database
      .prepare("SELECT id,user_id FROM speaker_profiles WHERE email IN (?,?)")
      .bind("race-one@example.test", "race-two@example.test")
      .all<{ id: string; user_id: string }>();
    expect(sameSourceProfiles.results).toHaveLength(1);
    const sameSourceUserId = sameSourceProfiles.results?.[0]?.user_id;
    expect(sameSourceUserId).toBeTruthy();
    await expect(
      identityDirectory.isSpeakerForEvent(sameSourceUserId ?? "", eventId),
    ).resolves.toBe(true);

    const sameEmail = "shared-race@example.test";
    const sameEmailRace = await Promise.all([
      adapter.createOrLink({
        ...command,
        source: { kind: "crm-prospect", id: "10000000-0000-4000-8000-000000000003" },
        email: sameEmail,
      }),
      adapter.createOrLink({
        ...command,
        source: { kind: "crm-prospect", id: "10000000-0000-4000-8000-000000000004" },
        email: sameEmail.toUpperCase(),
      }),
    ]);
    expect(sameEmailRace[0]?.speakerId).toBe(sameEmailRace[1]?.speakerId);
    const sameEmailProfiles = await database
      .prepare("SELECT id FROM speaker_profiles WHERE lower(email)=?")
      .bind(sameEmail)
      .all<{ id: string }>();
    expect(sameEmailProfiles.results).toHaveLength(1);
    await expect(identityDirectory.findByPersona("speaker")).resolves.toMatchObject({
      id: "seed-speaker",
    });
  });
});
