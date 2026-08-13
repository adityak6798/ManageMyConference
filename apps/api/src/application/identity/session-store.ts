/**
 * The record of an issued session, which is what makes sign-out revocation.
 *
 * The session cookie is still a signed bearer — the signature is what stops a forged one — but
 * it now names a row, and the row is what says whether the credential is still live. That is the
 * whole difference between "this browser forgot its cookie" and "that session is over
 * everywhere".
 *
 * The port is here, in the application layer, and its D1 implementation is in
 * `adapters/persistence/d1-identity-sessions.ts`. The transport receives this behaviour object
 * and never the signing secret, the same rule `GoogleAuthProvider` follows.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */
import type { AuditContext } from "./audit";

export interface SessionRecord {
  id: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionStore {
  /** Records the session and its `session.issued` audit row in one D1 batch. */
  issue(record: SessionRecord, context: AuditContext): Promise<void>;
  /**
   * The live, unrevoked, unexpired session with this id — or null.
   *
   * The `userId` it returns exists to scope revocation and to be compared with the one the
   * signed cookie already carries. It is never a second way to resolve an actor: actor
   * resolution is `findByPersona` for a demo persona and `findByUserId` for a real user, and
   * adding a third route through a session row is exactly the crossing
   * `docs/architecture/authorization.md` forbids.
   */
  find(id: string, now: number): Promise<{ userId: string } | null>;
  /**
   * Rows revoked, with the `session.signed_out` row in the same batch. Zero is a legitimate
   * answer — an already-revoked or unknown session — and a driver that cannot say how many rows
   * it touched is a failure rather than either.
   */
  revoke(id: string, now: number, context: AuditContext): Promise<number>;
  /** Every live session of one user, with the `session.revoked_all` row in the same batch. */
  revokeAllForUser(userId: string, now: number, context: AuditContext): Promise<number>;
}
