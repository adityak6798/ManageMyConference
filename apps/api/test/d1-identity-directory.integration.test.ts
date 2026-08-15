// @acceptance ACC-IDENTITY-EVENTS
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { capabilitySchema, sessionResponseSchema } from "@greenroom/contracts";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import type { IdentityDatabasePort } from "../src/adapters/persistence/d1-identity-directory";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

describe("D1IdentityDirectory", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  /*
   * Every capability the server can put in a session has to be one the browser's schema knows.
   *
   * This is not a style rule. `/api/session` is decoded against `sessionResponseSchema` before the
   * console renders anything, so **one unknown capability does not degrade a screen — it stops the
   * console loading at all**, and the person sees the signed-out surface with a generic error.
   * That is exactly what shipping `reports:pii` in the organizer grant and not in the contract's
   * enum did: 56 of 73 browser journeys failed at "Continue as organizer", and no unit test
   * noticed, because the in-memory demo actor is a *second* capability map that did not have it.
   *
   * So this asserts the real one, resolved out of migrated D1, against the schema the browser uses.
   */
  it("issues no capability the browser's contract cannot read", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-capabilities", seed: true });
    runtime = migrated.runtime;
    const directory = new D1IdentityDirectory(migrated.database as IdentityDatabasePort);

    for (const persona of ["organizer", "reviewer", "speaker"] as const) {
      const actor = await directory.findByPersona(persona);
      if (!actor) throw new Error(`the seed has no ${persona}`);
      for (const capability of actor.capabilities)
        expect(() => capabilitySchema.parse(capability)).not.toThrow();
      // The whole payload, because the enum is only one of the ways a session can fail to decode.
      expect(() =>
        sessionResponseSchema.parse({
          actor: { id: actor.id, name: actor.name, persona: actor.persona },
          organizations: actor.organizations,
          eventAccess: actor.eventAccess.map((access) => ({
            eventId: access.eventId,
            role: access.role,
            capabilities: [...access.capabilities],
          })),
          capabilities: [...actor.capabilities],
          authentication: "demo",
        }),
      ).not.toThrow();
    }
  });

  it("uses migrated memberships and roles as the authorization source", async () => {
    const migrated = await createMigratedDatabase({ label: "identity", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;

    const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
    await expect(
      directory.isAssignedToEvent("seed-organizer", "00000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(true);
    await expect(
      directory.isAssignedToEvent("seed-organizer", "00000000-0000-4000-8000-000000000099"),
    ).resolves.toBe(false);
    await expect(directory.findByPersona("organizer")).resolves.toMatchObject({
      organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
      eventAccess: expect.arrayContaining([
        {
          eventId: "00000000-0000-4000-8000-000000000001",
          role: "organizer",
          capabilities: expect.any(Set),
        },
      ]),
      capabilities: new Set([
        "events:read",
        "events:create",
        "communications:manage",
        "events:settings:read",
        "events:settings:update",
        "agenda:manage",
        "crm:manage",
        "content:read",
        "content:manage",
        "review:manage",
        "identity:manage",
        // Reading unmasked personal data in a report. Organizers hold it; every narrower built-in
        // role does not, and a custom role gets it only when an administrator grants it (#196).
        "reports:pii",
        "review:evaluate",
      ]),
    });
    await directory.grantOrganizer("00000000-0000-4000-8000-000000000002", "seed-reviewer");
    await expect(directory.findByPersona("reviewer")).resolves.toMatchObject({
      eventAccess: expect.arrayContaining([
        expect.objectContaining({
          eventId: "00000000-0000-4000-8000-000000000002",
          role: "organizer",
        }),
      ]),
      capabilities: new Set([
        "events:read",
        "communications:manage",
        "events:settings:read",
        "events:settings:update",
        "agenda:manage",
        "crm:manage",
        "content:read",
        "content:manage",
        "review:manage",
        "identity:manage",
        "reports:pii",
        "review:evaluate",
      ]),
    });

    await database
      .prepare("DELETE FROM event_roles WHERE user_id = ?")
      .bind("seed-organizer")
      .run();
    await expect(
      directory.isAssignedToEvent("seed-organizer", "00000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(false);
    await database
      .prepare("DELETE FROM organization_memberships WHERE user_id = ?")
      .bind("seed-organizer")
      .run();
    await expect(directory.findByPersona("organizer")).resolves.toMatchObject({
      organizations: [],
      eventAccess: [],
      capabilities: new Set(),
    });
  });

  it("lists an event's speakers with the address each can be reached at", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-speakers", seed: true });
    runtime = migrated.runtime;
    const directory = new D1IdentityDirectory(migrated.database as IdentityDatabasePort);

    const speakers = await directory.listSpeakersForEvent("00000000-0000-4000-8000-000000000001");

    // A speaker whose identity has no linked address is still a speaker and still listed, with
    // `email: null`. Omitting them would let a caller send to fewer people than it reported.
    expect(speakers).toEqual([
      { id: "speaker-jordan-bell", name: "Jordan Bell", email: null },
      { id: "seed-speaker", name: "Sam Speaker", email: "speaker@greenroom.test" },
    ]);
    // Event-scoped: the organizer, the reviewer and the public persona hold roles on this event
    // and none of them is a speaker.
    expect(speakers.map(({ id }) => id)).not.toContain("seed-organizer");
    // And a role held on one event never leaks into another's list.
    await expect(
      directory.listSpeakersForEvent("00000000-0000-4000-8000-000000000002"),
    ).resolves.toEqual([]);
  });

  it("enforces attempt, expiry, and one-time challenge semantics in migrated D1", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-challenges", seed: true });
    runtime = migrated.runtime;
    const directory = new D1IdentityDirectory(migrated.database as IdentityDatabasePort);

    await directory.saveLoginChallenge({
      id: "wrong-attempts",
      email: "organizer@greenroom.test",
      codeProof: "correct-proof",
      expiresAt: 2_000,
    });
    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(
        directory.consumeLoginChallenge("wrong-attempts", "wrong-proof", 1_000),
      ).resolves.toBeNull();
    await expect(
      directory.consumeLoginChallenge("wrong-attempts", "correct-proof", 1_000),
    ).resolves.toBeNull();

    await directory.saveLoginChallenge({
      id: "single-use",
      email: "organizer@greenroom.test",
      codeProof: "correct-proof",
      expiresAt: 2_000,
    });
    await expect(
      directory.consumeLoginChallenge("single-use", "correct-proof", 1_000),
    ).resolves.toBe("organizer@greenroom.test");
    await expect(
      directory.consumeLoginChallenge("single-use", "correct-proof", 1_000),
    ).resolves.toBeNull();

    await directory.saveLoginChallenge({
      id: "expired",
      email: "organizer@greenroom.test",
      codeProof: "correct-proof",
      expiresAt: 2_000,
    });
    await expect(
      directory.consumeLoginChallenge("expired", "correct-proof", 2_000),
    ).resolves.toBeNull();
  });
});
