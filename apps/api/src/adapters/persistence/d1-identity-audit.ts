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

const COLUMNS =
  "id, occurred_at, action, outcome, source, actor_user_id, subject_user_id, organization_id, event_id, correlation_id, detail";

const INSERT_AUDIT_EVENT = `INSERT INTO identity_audit_events (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * The same insert, but only if the statement before it in the batch changed something.
 *
 * A conditional write — revoking a session, removing a membership — can legitimately match zero
 * rows, and an audit row beside it saying `succeeded` would then be a record of something that
 * did not happen. The count is not known when the batch is built, so the guard is in SQL:
 * `changes()` reports the preceding statement's affected rows, and D1 runs a batch as one
 * sequential transaction, so this is that count.
 *
 * The alternative was writing the audit row after reading the count, which costs a second round
 * trip and, worse, lets the two land apart — an audit row that can outlive a rolled-back change
 * is the thing that makes an audit trail worthless.
 *
 * Not writing a row at all is the right answer here rather than writing one with
 * `outcome: 'refused'`. A sign-out that matched no live session is a no-op, not a refusal: the
 * caller was not denied anything. And a validly-signed but already-dead cookie can be replayed
 * at this route without limit, so a row per attempt would let anybody holding one grow an
 * append-only table nothing prunes. A refusal that *is* a refusal — a demo persona named as a
 * grant target — is written unconditionally, because that one really did happen.
 */
const INSERT_AUDIT_EVENT_WHEN_CHANGED = `INSERT INTO identity_audit_events (${COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes() > 0`;

/**
 * One bound insert, ready to be batched with the change it records.
 *
 * `detail` is serialized here rather than by the caller so that no call site has to remember it
 * is JSON. Nothing that reaches it may be a credential — see `application/identity/audit.ts`.
 *
 * `onlyWhenChanged` makes the row conditional on the preceding statement in the same batch
 * having affected a row. Use it for every conditional write; see the constant above for why.
 */
export function auditEventStatement(
  database: AuditDatabasePort,
  entry: AuditEntry,
  context: AuditContext,
  options: { onlyWhenChanged?: boolean } = {},
): D1Statement {
  return database
    .prepare(options.onlyWhenChanged ? INSERT_AUDIT_EVENT_WHEN_CHANGED : INSERT_AUDIT_EVENT)
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
