// @acceptance ACC-OPS
/**
 * The capability-URL convention and the per-event field locks, against a real migrated D1.
 *
 * Both are primitives other lanes are meant to consume — issue #189's `GAP-028` residual needs an
 * anonymous token addressing a speaker profile or asset, and a speaker-portal write surface
 * configured per event rather than fixed in code — so the properties that make them safe are
 * asserted here rather than left to their first consumer to discover.
 *
 * **Spending a view is one statement.** Two resolves of a one-view link must not both succeed,
 * and only a single `UPDATE … RETURNING` can promise that; a read followed by a write lets both
 * pass the test before either writes. Whether the guard really holds is a property of SQLite.
 *
 * **Every refusal is the same refusal.** Unknown, revoked, expired and spent all match no row, so
 * the resolver cannot be used to tell a real token from a guessed one.
 *
 * The other half of the pair — per-event field locks — is asserted in
 * `d1-custom-roles.integration.test.ts`, because `event_field_locks` is identity-access's table
 * and platform reads none of it.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapabilityLinkDatabasePort,
  D1CapabilityLinkStore,
} from "../src/adapters/persistence/d1-capability-links";
import type { CapabilityLink } from "../src/application/platform/capability-link";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-14T09:00:00.000Z";
const LATER = "2026-08-15T09:00:00.000Z";

const linkOf = (
  over: Partial<CapabilityLink & { tokenHash: string; passwordHash: string | null }> = {},
) => ({
  id: "00000000-0000-4000-8000-0000000000f0",
  kind: "report" as const,
  resourceRef: "00000000-0000-4000-8000-0000000000f1",
  organizationId: DEMO_ORGANIZATION,
  eventId: DEMO_EVENT,
  createdBy: "seed-organizer",
  createdAt: NOW,
  expiresAt: LATER,
  viewLimit: null,
  views: 0,
  revokedAt: null,
  hasPassword: false,
  scope: { allowPii: false },
  tokenHash: "a".repeat(64),
  passwordHash: null,
  ...over,
});

describe("capability links against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "capability-links" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as CapabilityLinkDatabasePort;
    return { database, store: new D1CapabilityLinkStore(database) };
  }

  it("round-trips a link, keeping its per-kind scope opaque", async () => {
    const { store } = await stack();
    await store.create(linkOf({ scope: { allowPii: true, anything: "the kind decides" } }));
    const listed = await store.list("report", "00000000-0000-4000-8000-0000000000f1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.scope).toEqual({ allowPii: true, anything: "the kind decides" });
    // Only the digest is stored; a link is never listed with its token.
    expect(JSON.stringify(listed[0])).not.toContain("a".repeat(64));
  });

  it("spends exactly one view of a one-view link", async () => {
    const { store } = await stack();
    await store.create(linkOf({ viewLimit: 1 }));
    expect(await store.spend("a".repeat(64), "report", null, NOW)).not.toBeNull();
    // The second resolve matches no row, because liveness and the increment are one statement.
    expect(await store.spend("a".repeat(64), "report", null, NOW)).toBeNull();
  });

  it("answers unknown, revoked and expired links identically", async () => {
    const { store } = await stack();
    await store.create(
      linkOf({ id: "00000000-0000-4000-8000-0000000000f2", tokenHash: "b".repeat(64) }),
    );
    await store.create(
      linkOf({
        id: "00000000-0000-4000-8000-0000000000f3",
        tokenHash: "c".repeat(64),
        expiresAt: NOW,
      }),
    );
    expect(await store.spend("d".repeat(64), "report", null, NOW)).toBeNull();
    await store.revoke(
      "report",
      "00000000-0000-4000-8000-0000000000f1",
      "00000000-0000-4000-8000-0000000000f2",
      NOW,
    );
    expect(await store.spend("b".repeat(64), "report", null, NOW)).toBeNull();
    // Expired: `expires_at > ?` is strict, so a link expiring at this instant is already gone.
    expect(await store.spend("c".repeat(64), "report", null, NOW)).toBeNull();
  });

  it("does not spend a limited view for the wrong kind or password", async () => {
    const { store } = await stack();
    await store.create(linkOf({ viewLimit: 1, passwordHash: "p".repeat(64), hasPassword: true }));
    expect(await store.spend("a".repeat(64), "speaker-profile", "p".repeat(64), NOW)).toBeNull();
    expect(await store.spend("a".repeat(64), "report", "x".repeat(64), NOW)).toBeNull();
    expect(await store.spend("a".repeat(64), "report", "p".repeat(64), NOW)).not.toBeNull();
  });

  it("scopes revocation to the resource it names", async () => {
    const { store } = await stack();
    await store.create(linkOf());
    // A link belonging to another resource — or another kind — is not this caller's to revoke.
    expect(await store.revoke("report", "some-other-report", linkOf().id, NOW)).toBe(0);
    expect(await store.revoke("speaker-profile", linkOf().resourceRef, linkOf().id, NOW)).toBe(0);
    expect(await store.revoke("report", linkOf().resourceRef, linkOf().id, NOW)).toBe(1);
  });
});
