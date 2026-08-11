// @acceptance ACC-CRM
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";

describe("content speaker conversion", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("links CRM provenance to an existing event speaker with the same email", async () => {
    const migrated = await createMigratedDatabase({ label: "speaker-conversion", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
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
