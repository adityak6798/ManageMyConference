// @acceptance ACC-IDENTITY-EVENTS
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
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

  it("uses migrated memberships and roles as the authorization source", async () => {
    const migrated = await createMigratedDatabase({ label: "identity", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;

    const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
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
        "review:evaluate",
      ]),
    });

    await database
      .prepare("DELETE FROM event_roles WHERE user_id = ?")
      .bind("seed-organizer")
      .run();
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
