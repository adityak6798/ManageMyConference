/**
 * `SessionStore` against D1.
 *
 * Two conventions are load-bearing here.
 *
 * **Every write is batched with its audit row.** D1 runs a batch as one transaction, so a
 * revocation and the record of it land together or neither does.
 *
 * **A conditional write's correctness is its affected-row count**, so `revoke` and
 * `revokeAllForUser` go through `changedRows`. A driver that cannot say how many rows it touched
 * is a failure, never a silent zero and never a silent one:
 * `POST /api/auth/sessions/revoke-all` reports that number to the caller, and a fabricated count
 * would be this domain telling somebody their other devices are signed out when they are not.
 *
 * `IdentityDatabasePort` in `d1-identity-directory.ts` declares `run()` without `meta`, which is
 * why this adapter declares its own port at the `D1WriteResult` shape rather than widening one
 * that nine reads share. `d1-content-repository.ts` is the reference implementation of the
 * convention.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */
import type { AuditContext, AuditEntry } from "../../application/identity/audit";
import type { SessionRecord, SessionStore } from "../../application/identity/session-store";
import { type AuditDatabasePort, auditEventStatement } from "./d1-identity-audit";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface SessionDatabasePort extends AuditDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

/** A live session: not revoked, and not yet expired. Both halves are in the SQL, not in JS. */
const LIVE_SESSION = "revoked_at IS NULL AND expires_at > ?";

export class D1SessionStore implements SessionStore {
  constructor(private readonly database: SessionDatabasePort) {}

  async issue(record: SessionRecord, context: AuditContext): Promise<void> {
    const [inserted] = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO identity_sessions (id, user_id, issued_at, expires_at) VALUES (?,?,?,?)",
        )
        .bind(record.id, record.userId, record.issuedAt, record.expiresAt),
      auditEventStatement(
        this.database,
        {
          action: "session.issued",
          outcome: "succeeded",
          occurredAt: record.issuedAt,
          subjectUserId: record.userId,
          detail: { expiresAt: record.expiresAt },
        },
        context,
      ),
    ]);
    if (!inserted?.success)
      throw new Error(`D1 failed to record a session: ${inserted?.error ?? "unknown error"}`);
    // A session id is a fresh UUID, so the only way this is not 1 is that the insert did not
    // happen — which would leave a cookie naming a row that never existed.
    if (changedRows(inserted, "record an issued session") !== 1)
      throw new Error("D1 recorded no row while issuing a session");
  }

  async find(id: string, now: number): Promise<{ userId: string } | null> {
    const found = await this.database
      .prepare(`SELECT user_id FROM identity_sessions WHERE id = ? AND ${LIVE_SESSION} LIMIT 1`)
      .bind(id, now)
      .all<{ user_id: string }>();
    if (!found.success)
      throw new Error(`D1 failed to read a session: ${found.error ?? "unknown error"}`);
    const row = found.results?.[0];
    return row ? { userId: row.user_id } : null;
  }

  revoke(id: string, now: number, context: AuditContext): Promise<number> {
    return this.write(
      this.database
        .prepare(`UPDATE identity_sessions SET revoked_at = ? WHERE id = ? AND ${LIVE_SESSION}`)
        .bind(now, id, now),
      {
        action: "session.signed_out" as const,
        occurredAt: now,
        ...(context.actorUserId ? { subjectUserId: context.actorUserId } : {}),
        detail: { sessionId: id },
      },
      context,
      "revoke a session",
    );
  }

  revokeAllForUser(userId: string, now: number, context: AuditContext): Promise<number> {
    return this.write(
      this.database
        .prepare(
          // `user_id` is what scopes this to one person. Dropping it would end every session in
          // the deployment, which is why `d1-identity-sessions.integration.test.ts` proves that
          // another user's session survives.
          `UPDATE identity_sessions SET revoked_at = ? WHERE user_id = ? AND ${LIVE_SESSION}`,
        )
        .bind(now, userId, now),
      {
        action: "session.revoked_all" as const,
        occurredAt: now,
        subjectUserId: userId,
      },
      context,
      "revoke every session for a user",
    );
  }

  /**
   * One conditional write and its audit row, as one batch, answering the affected-row count.
   *
   * The row records that the action was taken; the count is the caller's answer and not part of
   * the claim. Putting the count *in* the row would mean writing it after the update, which is
   * the second round trip this batch exists to avoid — and an audit row that can outlive a
   * rolled-back change is the thing that makes an audit trail worthless.
   */
  private async write(
    statement: D1Statement,
    entry: Omit<AuditEntry, "outcome">,
    context: AuditContext,
    operation: string,
  ): Promise<number> {
    const [changed] = await this.database.batch([
      statement,
      auditEventStatement(this.database, { ...entry, outcome: "succeeded" }, context),
    ]);
    if (!changed?.success)
      throw new Error(`D1 failed to ${operation}: ${changed?.error ?? "unknown error"}`);
    return changedRows(changed, operation);
  }
}
