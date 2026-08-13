// @acceptance ACC-IDENTITY-EVENTS
/**
 * Durable sessions against a real, migrated, seeded D1 database.
 *
 * Three properties are only true here. **Atomicity**: the state change and its audit row are one
 * D1 batch, so neither can outlive the other — an in-memory double agrees with itself about that
 * and proves nothing. **Scope**: `revokeAllForUser` is a single `UPDATE` whose `WHERE user_id`
 * predicate is what keeps it from ending the whole deployment's sessions, and only SQLite can
 * say whether that predicate does what it claims. **Row counts**: `changedRows` refuses a driver
 * that cannot say how many rows it touched, and the count is what the revoke-all response
 * reports to a person deciding whether their stolen cookie is dead.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1SessionStore,
  type SessionDatabasePort,
} from "../src/adapters/persistence/d1-identity-sessions";
import type { AuditContext } from "../src/application/identity/audit";
import { createMigratedDatabase } from "./support/seeded-d1";

const ORGANIZER = "seed-organizer";
const REVIEWER = "seed-reviewer";
const NOW = 1_760_000_000_000;
const LATER = NOW + 60_000;
const EXPIRES = NOW + 28_800_000;

const context = (actorUserId: string): AuditContext => ({
  correlationId: "correlation-under-test",
  actorUserId,
  source: "human",
});

interface AuditRow {
  action: string;
  outcome: string;
  source: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  correlation_id: string;
  detail: string | null;
}

describe("identity sessions against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  /** A seeded database — the four personas exist as `users` rows — and a store over it. */
  async function store() {
    const migrated = await createMigratedDatabase({ seed: true, label: "identity-sessions" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as SessionDatabasePort;
    const audit = async (): Promise<AuditRow[]> =>
      (
        await database
          .prepare(
            "SELECT action, outcome, source, actor_user_id, subject_user_id, correlation_id, detail FROM identity_audit_events ORDER BY occurred_at, action",
          )
          .all<AuditRow>()
      ).results ?? [];
    const row = async (id: string) =>
      (
        await database
          .prepare("SELECT id, user_id, revoked_at FROM identity_sessions WHERE id = ?")
          .bind(id)
          .all<{ id: string; user_id: string; revoked_at: number | null }>()
      ).results?.[0] ?? null;
    return { sessions: new D1SessionStore(database), database, audit, row };
  }

  it("records a session and its audit row together, and finds it while it is live", async () => {
    const { sessions, audit, row } = await store();
    await sessions.issue(
      { id: "sid-1", userId: ORGANIZER, issuedAt: NOW, expiresAt: EXPIRES },
      context(ORGANIZER),
    );

    await expect(sessions.find("sid-1", LATER)).resolves.toEqual({ userId: ORGANIZER });
    expect(await row("sid-1")).toMatchObject({ user_id: ORGANIZER, revoked_at: null });
    expect(await audit()).toEqual([
      {
        action: "session.issued",
        outcome: "succeeded",
        source: "human",
        actor_user_id: ORGANIZER,
        subject_user_id: ORGANIZER,
        correlation_id: "correlation-under-test",
        detail: JSON.stringify({ expiresAt: EXPIRES }),
      },
    ]);
  });

  it("stops finding a session once it is revoked, and once it has expired", async () => {
    const { sessions } = await store();
    await sessions.issue(
      { id: "sid-live", userId: ORGANIZER, issuedAt: NOW, expiresAt: EXPIRES },
      context(ORGANIZER),
    );
    await sessions.issue(
      { id: "sid-expiring", userId: ORGANIZER, issuedAt: NOW, expiresAt: LATER },
      context(ORGANIZER),
    );

    await expect(sessions.revoke("sid-live", LATER, context(ORGANIZER))).resolves.toBe(1);
    await expect(sessions.find("sid-live", LATER)).resolves.toBeNull();
    // Expiry is enforced in the same `WHERE` as revocation, so a row nobody revoked still stops
    // resolving on its own.
    await expect(sessions.find("sid-expiring", LATER)).resolves.toBeNull();

    // Revoking twice is zero rows, not an error and not a fabricated one: an already-revoked
    // session is a legitimate answer, and so is a session id that never existed.
    await expect(sessions.revoke("sid-live", LATER, context(ORGANIZER))).resolves.toBe(0);
    await expect(sessions.revoke("sid-unknown", LATER, context(ORGANIZER))).resolves.toBe(0);
  });

  /**
   * The mutation to try: drop `AND user_id = ?` from `revokeAllForUser` and this fails on the
   * reviewer's session, which is the one row that must survive.
   */
  it("revokes every live session of one user and no session of another", async () => {
    const { sessions } = await store();
    for (const id of ["sid-laptop", "sid-phone"])
      await sessions.issue(
        { id, userId: ORGANIZER, issuedAt: NOW, expiresAt: EXPIRES },
        context(ORGANIZER),
      );
    await sessions.issue(
      { id: "sid-reviewer", userId: REVIEWER, issuedAt: NOW, expiresAt: EXPIRES },
      context(REVIEWER),
    );
    // Already dead before the sweep, so it cannot inflate the count the caller is shown.
    await sessions.issue(
      { id: "sid-old", userId: ORGANIZER, issuedAt: NOW, expiresAt: LATER },
      context(ORGANIZER),
    );

    await expect(sessions.revokeAllForUser(ORGANIZER, LATER, context(ORGANIZER))).resolves.toBe(2);
    for (const id of ["sid-laptop", "sid-phone"])
      await expect(sessions.find(id, LATER)).resolves.toBeNull();
    await expect(sessions.find("sid-reviewer", LATER)).resolves.toEqual({ userId: REVIEWER });
  });

  /**
   * A write that changed nothing writes no audit row.
   *
   * Two properties in one. The record has to be true — an audit row saying a session was signed
   * out when the `UPDATE` matched nothing is a claim about something that did not happen, and it
   * is the operator reading this table afterwards who is misled by it. And the table has to be
   * hard to grow: `/api/auth/signout` has no throttle, `identity_audit_events` is append-only and
   * nothing prunes it, so a row per attempt would let anybody holding a validly-signed dead
   * cookie write to it at will.
   *
   * The guard is `changes() > 0` in the audit INSERT, which only means anything against a real
   * driver — it depends on D1 running a batch as one sequential transaction, so `changes()` in
   * the second statement reports the first statement's row count. That is why this case is here
   * and not in the in-memory suite.
   */
  it("writes no audit row for a revocation that changed nothing", async () => {
    const { sessions, audit } = await store();
    await sessions.issue(
      { id: "sid-1", userId: ORGANIZER, issuedAt: NOW, expiresAt: EXPIRES },
      context(ORGANIZER),
    );
    expect(await audit()).toHaveLength(1);

    // A session that never existed, five times over — the replay an expired-cookie holder would
    // otherwise have.
    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(sessions.revoke("sid-never-existed", LATER, context(ORGANIZER))).resolves.toBe(
        0,
      );
    // And a real revocation repeated: the first changes a row, the rest do not.
    await expect(sessions.revoke("sid-1", LATER, context(ORGANIZER))).resolves.toBe(1);
    await expect(sessions.revoke("sid-1", LATER, context(ORGANIZER))).resolves.toBe(0);
    await expect(sessions.revokeAllForUser(ORGANIZER, LATER, context(ORGANIZER))).resolves.toBe(0);

    // Exactly two rows: the issue, and the one revocation that happened.
    expect((await audit()).map((entry) => entry.action)).toEqual([
      "session.issued",
      "session.signed_out",
    ]);
  });

  it("keeps every audit row, including the ones about sessions that no longer resolve", async () => {
    const { sessions, audit } = await store();
    for (const id of ["sid-laptop", "sid-phone"])
      await sessions.issue(
        { id, userId: ORGANIZER, issuedAt: NOW, expiresAt: EXPIRES },
        context(ORGANIZER),
      );
    // Sign out of one device, then out of everywhere — so the sweep still has a live session to
    // find and both actions genuinely happen.
    await sessions.revoke("sid-laptop", LATER, context(ORGANIZER));
    await expect(sessions.revokeAllForUser(ORGANIZER, LATER, context(ORGANIZER))).resolves.toBe(1);

    // Two issues, one sign-out, one sweep. Ordered by time then action, so the two issues share a
    // timestamp and sort by name. The revoked session's own rows survive its revocation, which is
    // the append-only property: history outlives the thing it describes.
    expect((await audit()).map((entry) => entry.action)).toEqual([
      "session.issued",
      "session.issued",
      "session.revoked_all",
      "session.signed_out",
    ]);
    // Nothing that could be a credential reached the table.
    for (const entry of await audit()) expect(entry.detail ?? "").not.toContain("secret");
  });

  /**
   * A driver that cannot say how many rows it touched is a failure.
   *
   * Not an integration case — it is about the adapter's contract with its driver, which no real
   * D1 can be made to violate. It lives beside the cases it protects because the thing it
   * protects is the number `revoke-all` reports: a silent 0 would tell somebody their other
   * devices are still signed in when they are not, and a silent 1 would tell them a stolen
   * cookie is dead when it is not.
   */
  it("refuses a write whose row count the driver did not report", async () => {
    const statement = {
      bind: () => statement,
      run: async () => ({ success: true }) as never,
      all: async () => ({ success: true, results: [] }),
    };
    const countless: SessionDatabasePort = {
      prepare: () => statement,
      batch: async () => [{ success: true } as never],
    };
    await expect(
      new D1SessionStore(countless).revoke("sid-1", NOW, context(ORGANIZER)),
    ).rejects.toThrow(/no row count/);
  });
});
