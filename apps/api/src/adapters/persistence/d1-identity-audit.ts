/**
 * The writer for `identity_audit_events`.
 *
 * It exports a *statement builder* rather than a `write()` method, and that is the whole design.
 * Every audit row in this domain is batched with the state change it describes, so the two land
 * together or neither does: an audit row cannot claim something that did not happen, and a state
 * change cannot happen unaudited. A writer that owned its own round trip would make both of
 * those possible.
 *
 * The table is append-only. There is no update and no delete here, and the seed reset is the
 * only statement in the repository that removes a row from it.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */
import type { AuditContext, AuditEntry } from "../../application/identity/audit";
import type { D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface AuditDatabasePort {
  prepare(query: string): D1Statement;
}

const INSERT_AUDIT_EVENT =
  "INSERT INTO identity_audit_events (id, occurred_at, action, outcome, source, actor_user_id, subject_user_id, organization_id, event_id, correlation_id, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)";

/**
 * One bound insert, ready to be batched with the change it records.
 *
 * `detail` is serialized here rather than by the caller so that no call site has to remember it
 * is JSON. Nothing that reaches it may be a credential — see `application/identity/audit.ts`.
 */
export function auditEventStatement(
  database: AuditDatabasePort,
  entry: AuditEntry,
  context: AuditContext,
): D1Statement {
  return database
    .prepare(INSERT_AUDIT_EVENT)
    .bind(
      crypto.randomUUID(),
      entry.occurredAt,
      entry.action,
      entry.outcome,
      context.source,
      context.actorUserId,
      entry.subjectUserId ?? null,
      entry.organizationId ?? null,
      entry.eventId ?? null,
      context.correlationId,
      entry.detail ? JSON.stringify(entry.detail) : null,
    );
}
