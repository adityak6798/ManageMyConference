/**
 * An in-memory `SessionStore` for the HTTP tests.
 *
 * It keeps the audit entries it was handed, so a test can assert that a state change and its
 * record travelled together without a database. The D1 implementation's own guarantee — that
 * they land in one batch or not at all — is proved against real D1 in
 * `d1-identity-sessions.integration.test.ts`, because it is a property of the driver rather than
 * of the interface.
 */
import type { AuditContext, AuditEntry } from "../../src/application/identity/audit";
import type { SessionRecord, SessionStore } from "../../src/application/identity/session-store";

export interface MemorySessionStore extends SessionStore {
  readonly rows: Map<string, SessionRecord & { revokedAt: number | null }>;
  readonly audit: Array<AuditEntry & { context: AuditContext }>;
  /** How many times `find` was asked, so a test can prove a path took no lookup. */
  readonly lookups: string[];
  /** Put a session in the store without going through a sign-in route. */
  seed(record: SessionRecord): void;
}

export function memorySessionStore(): MemorySessionStore {
  const rows = new Map<string, SessionRecord & { revokedAt: number | null }>();
  const audit: Array<AuditEntry & { context: AuditContext }> = [];
  const lookups: string[] = [];
  const record = (entry: AuditEntry, context: AuditContext) => audit.push({ ...entry, context });

  return {
    rows,
    audit,
    lookups,
    seed(session) {
      rows.set(session.id, { ...session, revokedAt: null });
    },
    async issue(session, context) {
      rows.set(session.id, { ...session, revokedAt: null });
      record(
        {
          action: "session.issued",
          outcome: "succeeded",
          occurredAt: session.issuedAt,
          subjectUserId: session.userId,
        },
        context,
      );
    },
    async find(id, now) {
      lookups.push(id);
      const row = rows.get(id);
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
      return { userId: row.userId };
    },
    // The audit row follows the change, exactly as the D1 writer's `changes() > 0` guard makes
    // it: a revocation that matched nothing records nothing. A double that recorded anyway would
    // let an HTTP test pass over the behaviour the production adapter refuses — which is how the
    // same defect survived two rounds of review in the first place.
    async revoke(id, now, context) {
      const row = rows.get(id);
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return 0;
      row.revokedAt = now;
      record(
        {
          action: "session.signed_out",
          outcome: "succeeded",
          occurredAt: now,
          detail: { sessionId: id },
        },
        context,
      );
      return 1;
    },
    async revokeAllForUser(userId, now, context) {
      let revoked = 0;
      for (const row of rows.values())
        if (row.userId === userId && row.revokedAt === null && row.expiresAt > now) {
          row.revokedAt = now;
          revoked += 1;
        }
      if (revoked > 0)
        record(
          {
            action: "session.revoked_all",
            outcome: "succeeded",
            occurredAt: now,
            subjectUserId: userId,
          },
          context,
        );
      return revoked;
    },
  };
}
