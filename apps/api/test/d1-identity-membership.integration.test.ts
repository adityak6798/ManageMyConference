// @acceptance ACC-IDENTITY-EVENTS
/**
 * Membership administration against a real, migrated, seeded D1 database.
 *
 * Four things are only true here.
 *
 * **Single use.** Acceptance is a conditional `UPDATE … RETURNING` on `accepted_at IS NULL`, and
 * whether that really admits exactly one of two callers racing the same token is a property of
 * SQLite rather than of the TypeScript around it.
 *
 * **Atomicity.** The grant and its audit row are one batch, and the audit row for a conditional
 * write carries `WHERE changes() > 0` — which only means anything against a driver that runs a
 * batch as one sequential transaction.
 *
 * **Immediate revocation.** `D1IdentityDirectory.resolve` re-derives the actor from D1 on every
 * request, so removing a role takes effect on the very next one without touching any session
 * record. That is asserted rather than engineered, and it is why removal does not revoke
 * sessions: the person may hold memberships elsewhere.
 *
 * **Scope.** Removing somebody from an organization must not touch their roles on another
 * organization's events — scoped by the event ids the events domain supplies, because `events`
 * is that domain's table and identity-access reads none of it. Exactly the kind of predicate a
 * unit test with a fake cannot check.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1MembershipRepository,
  type MembershipDatabasePort,
} from "../src/adapters/persistence/d1-identity-membership";
import {
  D1IdentityDirectory,
  type IdentityDatabasePort,
} from "../src/adapters/persistence/d1-identity-directory";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import type { AuditContext } from "../src/application/identity/audit";
import { hashToken, mintInvitationToken } from "../src/application/identity/membership";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000020";
const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const NOW = 1_760_000_000_000;
const LATER = NOW + 60_000;
const EXPIRES = NOW + 604_800_000;

const context = (actorUserId: string | null): AuditContext => ({
  correlationId: "correlation-under-test",
  actorUserId,
  source: "human",
});

describe("membership administration against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "identity-membership" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as MembershipDatabasePort;
    const repository = new D1MembershipRepository(database);
    const directory = new D1IdentityDirectory(database as unknown as IdentityDatabasePort);
    /** A real (non-seeded) person who has signed in and holds no grant yet. */
    const invitee = "22222222-2222-4222-8222-222222222222";
    await database
      .prepare("INSERT INTO users (id, name, persona) VALUES (?, 'Ivy Invitee', 'organizer')")
      .bind(invitee)
      .run();
    const audit = async () =>
      (
        await database
          .prepare(
            "SELECT action, outcome, subject_user_id, organization_id, event_id FROM identity_audit_events ORDER BY occurred_at, action",
          )
          .all<{
            action: string;
            outcome: string;
            subject_user_id: string | null;
            organization_id: string | null;
            event_id: string | null;
          }>()
      ).results ?? [];
    return { database, repository, directory, invitee, audit };
  }

  it("grants organization membership to whoever accepts, and records both in one batch", async () => {
    const { repository, directory, invitee, audit } = await stack();
    const { token, tokenHash } = await mintInvitationToken();
    await repository.createInvitation(
      {
        id: "invitation-1",
        organizationId: DEMO_ORGANIZATION,
        eventId: null,
        email: "ivy@example.test",
        role: "organizer",
        tokenHash,
        invitedByUserId: "seed-organizer",
        createdAt: NOW,
        expiresAt: EXPIRES,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      },
      context("seed-organizer"),
    );

    await expect(
      repository.acceptInvitation({
        tokenHash: (await hashToken(token)).tokenHash,
        userId: invitee,
        now: LATER,
        context: context(invitee),
      }),
    ).resolves.toEqual({ organizationId: DEMO_ORGANIZATION, eventId: null, role: "organizer" });

    // The membership landed on the *accepting* identity, not on the invited address.
    const actor = await directory.findByUserId(invitee);
    expect(actor?.organizations.map(({ id }) => id)).toEqual([DEMO_ORGANIZATION]);
    expect((await audit()).map((row) => [row.action, row.subject_user_id])).toEqual([
      ["membership.invited", null],
      ["membership.accepted", invitee],
    ]);
  });

  /**
   * Two callers, one token. The `UPDATE` is the gate, so exactly one wins and the loser gets the
   * same indistinguishable null as an unknown token.
   */
  it("spends an invitation exactly once", async () => {
    const { repository, invitee } = await stack();
    const { token, tokenHash } = await mintInvitationToken();
    await repository.createInvitation(
      {
        id: "invitation-1",
        organizationId: DEMO_ORGANIZATION,
        eventId: null,
        email: "ivy@example.test",
        role: "organizer",
        tokenHash,
        invitedByUserId: "seed-organizer",
        createdAt: NOW,
        expiresAt: EXPIRES,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      },
      context("seed-organizer"),
    );
    const digest = (await hashToken(token)).tokenHash;
    const accept = () =>
      repository.acceptInvitation({
        tokenHash: digest,
        userId: invitee,
        now: LATER,
        context: context(invitee),
      });

    const [first, second] = await Promise.all([accept(), accept()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // And a third attempt afterwards is refused the same way.
    await expect(accept()).resolves.toBeNull();
  });

  it("refuses a revoked and an expired invitation indistinguishably", async () => {
    const { repository, invitee } = await stack();
    const make = async (id: string, expiresAt: number) => {
      const { token, tokenHash } = await mintInvitationToken();
      await repository.createInvitation(
        {
          id,
          organizationId: DEMO_ORGANIZATION,
          eventId: null,
          email: `${id}@example.test`,
          role: "organizer",
          tokenHash,
          invitedByUserId: "seed-organizer",
          createdAt: NOW,
          expiresAt,
          acceptedAt: null,
          acceptedByUserId: null,
          revokedAt: null,
        },
        context("seed-organizer"),
      );
      return (await hashToken(token)).tokenHash;
    };
    const revoked = await make("invitation-revoked", EXPIRES);
    const expired = await make("invitation-expired", LATER);
    await expect(
      repository.revokeInvitation(
        DEMO_ORGANIZATION,
        "invitation-revoked",
        LATER,
        context("seed-organizer"),
      ),
    ).resolves.toBe(1);

    for (const tokenHash of [revoked, expired])
      await expect(
        repository.acceptInvitation({
          tokenHash,
          userId: invitee,
          now: EXPIRES,
          context: context(invitee),
        }),
      ).resolves.toBeNull();
    // Revoking again changes nothing and writes no second audit row.
    await expect(
      repository.revokeInvitation(
        DEMO_ORGANIZATION,
        "invitation-revoked",
        LATER,
        context("seed-organizer"),
      ),
    ).resolves.toBe(0);
    const revocations = (await repository.listAuditEvents(DEMO_ORGANIZATION, 50, null)).filter(
      (row) => row.action === "membership.invitation_revoked",
    );
    expect(revocations).toHaveLength(1);
  });

  /**
   * Removing a role takes effect on the next request, with no session touched.
   *
   * This is the property that makes revocation of *authorization* nearly free: the actor is
   * re-derived from D1 every request, so the grant table is the live answer. It is also why
   * removing a membership does not revoke sessions — the person may hold grants elsewhere that
   * are none of this organization's business.
   */
  it("takes effect on the next actor resolution without touching a session", async () => {
    const { repository, directory, invitee } = await stack();
    await repository.setEventRole(DEMO_EVENT, invitee, "reviewer", NOW, context("seed-organizer"));
    const staffed = await directory.findByUserId(invitee);
    expect(staffed?.eventAccess.map(({ eventId, role }) => [eventId, role])).toEqual([
      [DEMO_EVENT, "reviewer"],
    ]);
    expect([...(staffed?.capabilities ?? [])]).toContain("review:evaluate");

    await expect(
      repository.revokeEventRole(DEMO_EVENT, invitee, "reviewer", LATER, context("seed-organizer")),
    ).resolves.toBe(1);
    const removed = await directory.findByUserId(invitee);
    expect(removed?.eventAccess).toEqual([]);
    expect([...(removed?.capabilities ?? [])]).not.toContain("review:evaluate");
  });

  it("re-granting a role somebody already holds changes nothing and records nothing", async () => {
    const { repository, audit } = await stack();
    // The seeded reviewer already holds `reviewer` on the demo event, from seed SQL.
    await expect(
      repository.setEventRole(
        DEMO_EVENT,
        "seed-reviewer",
        "reviewer",
        NOW,
        context("seed-organizer"),
      ),
    ).resolves.toBe(0);
    expect((await audit()).filter((row) => row.action === "event_role.granted")).toEqual([]);
  });

  /**
   * The mutation to try: drop the `event_id IN (SELECT … WHERE organization_id = ?)` subquery
   * from `removeMember` and this fails on the role held in the other organization.
   */
  it("removes a member from this organization only, roles included", async () => {
    const { database, repository, directory, invitee } = await stack();
    // An event in a second organization, and the same person staffed on it. Created through the
    // events domain's own repository rather than by writing its table, which is the boundary this
    // test exists to check on the other side.
    const outsideEvent = "00000000-0000-4000-8000-0000000000f1";
    await new D1EventRepository(database as unknown as D1DatabasePort).create({
      id: outsideEvent,
      organizationId: OTHER_ORGANIZATION,
      name: "Outside Summit",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    for (const [organizationId, eventId] of [
      [DEMO_ORGANIZATION, DEMO_EVENT],
      [OTHER_ORGANIZATION, outsideEvent],
    ] as const) {
      await database
        .prepare(
          "INSERT OR IGNORE INTO organization_memberships (organization_id, user_id, role) VALUES (?,?,'organizer')",
        )
        .bind(organizationId, invitee)
        .run();
      await repository.setEventRole(eventId, invitee, "reviewer", NOW, context("seed-organizer"));
    }

    await expect(
      repository.removeMember(
        DEMO_ORGANIZATION,
        invitee,
        [DEMO_EVENT],
        LATER,
        context("seed-organizer"),
      ),
    ).resolves.toBe(1);
    const actor = await directory.findByUserId(invitee);
    expect(actor?.organizations.map(({ id }) => id)).toEqual([OTHER_ORGANIZATION]);
    // The other organization's role survives; the demo one's is gone.
    expect(actor?.eventAccess.map(({ eventId }) => eventId)).toEqual([outsideEvent]);
  });

  it("scopes the organizer audit log to its own organization", async () => {
    const { repository, invitee } = await stack();
    await repository.recordRefusal(
      {
        action: "event_role.granted",
        organizationId: DEMO_ORGANIZATION,
        subjectUserId: "seed-organizer",
        detail: { reason: "demo-persona-subject" },
      },
      context(invitee),
    );
    await repository.recordRefusal(
      { action: "membership.removed", organizationId: OTHER_ORGANIZATION },
      context(invitee),
    );

    const rows = await repository.listAuditEvents(DEMO_ORGANIZATION, 50, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "event_role.granted",
      outcome: "refused",
      subjectUserId: "seed-organizer",
      source: "human",
      correlationId: "correlation-under-test",
    });
    // A refusal is recorded, which is the row an operator most wants to find.
    expect(rows[0]?.detail).toContain("demo-persona-subject");
  });
});
