/*
 * The unified audit timeline against D1.
 *
 * Two ways in, matching the two ways a caller can need a record written: `append` writes it, and
 * `preparedAuditWriter` renders one into statements a caller appends to a batch it already had,
 * so a fact and the record of it commit together. The SQL and the column names live here and
 * nowhere else — a caller of the writer never learns either.
 *
 * @spec PRD-OPS-003
 */
import type {
  AuditRecord,
  AuditRecordStore,
  AuditSource,
  PreparedAuditRecord,
  PreparedAuditWriter,
} from "../../application/platform/public";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<D1WriteResult>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
type Database = { prepare(query: string): Statement };

interface AuditRow {
  id: string;
  organization_id: string;
  event_id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string;
  source: AuditSource;
  action: string;
  target_type: string;
  target_id: string;
  target_version: number | null;
  correlation_id: string | null;
  idempotency_key: string;
}

/**
 * `DO NOTHING` on the key, so a replayed command converges on one record.
 *
 * Not `DO UPDATE`: this table is append-only and the triggers in migration `1901` refuse an
 * UPDATE outright, so an upsert would turn a harmless retry into a failed request.
 */
const APPEND = `INSERT INTO platform_audit_records (
  id, organization_id, event_id, occurred_at, actor_id, actor_name, source,
  action, target_type, target_id, target_version, correlation_id, idempotency_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (organization_id, idempotency_key) DO NOTHING`;

const bindings = (record: PreparedAuditRecord): readonly unknown[] => [
  record.id,
  record.organizationId,
  record.eventId,
  record.occurredAt,
  record.actorId,
  record.actorName,
  record.source,
  record.action,
  record.targetType,
  record.targetId,
  record.targetVersion ?? null,
  record.correlationId,
  record.idempotencyKey,
];

const toRecord = (row: AuditRow): AuditRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  eventId: row.event_id,
  occurredAt: row.occurred_at,
  actorId: row.actor_id,
  actorName: row.actor_name,
  source: row.source,
  action: row.action,
  targetType: row.target_type,
  targetId: row.target_id,
  ...(row.target_version !== null ? { targetVersion: Number(row.target_version) } : {}),
  correlationId: row.correlation_id,
  idempotencyKey: row.idempotency_key,
});

export class D1AuditRecordStore implements AuditRecordStore {
  constructor(private readonly database: Database) {}

  /** True when this call wrote the row; false when the key was already present. */
  async append(record: AuditRecord): Promise<boolean> {
    const result = await this.database
      .prepare(APPEND)
      .bind(...bindings(record))
      .run();
    if (!result.success) throw new Error("Failed to append an audit record");
    // Returned rather than discarded, so "already recorded" and "recorded" are distinguishable by
    // a caller that cares. A driver that cannot say how many rows it touched is refused outright,
    // because neither answer may be guessed.
    return changedRows(result, "append an audit record") > 0;
  }

  /**
   * One page, newest first, keyed on `(occurred_at, id)`.
   *
   * The id is in the key because two records written in the same millisecond are ordinary — a
   * publication and its announcement, for instance — and a cursor on the timestamp alone would
   * either repeat one of them or skip it.
   */
  async page(
    eventId: string,
    page: { limit: number; before?: { occurredAt: string; id: string } },
  ): Promise<{ items: readonly AuditRecord[]; hasMore: boolean }> {
    const columns =
      "id, organization_id, event_id, occurred_at, actor_id, actor_name, source, action, target_type, target_id, target_version, correlation_id, idempotency_key";
    // One row more than asked for, which is how `hasMore` is answered without a second count.
    const probe = page.limit + 1;
    const result = page.before
      ? await this.database
          .prepare(
            `SELECT ${columns} FROM platform_audit_records WHERE event_id = ? AND (occurred_at, id) < (?, ?) ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          )
          .bind(eventId, page.before.occurredAt, page.before.id, probe)
          .all<AuditRow>()
      : await this.database
          .prepare(
            `SELECT ${columns} FROM platform_audit_records WHERE event_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          )
          .bind(eventId, probe)
          .all<AuditRow>();
    if (!result.success) throw new Error("Failed to read the audit timeline");
    const rows = result.results ?? [];
    return {
      items: rows.slice(0, page.limit).map(toRecord),
      hasMore: rows.length > page.limit,
    };
  }
}

/**
 * Binds the prepared-record writer to a concrete D1 database.
 *
 * The caller appends the returned statements to its own batch, so the record and the fact that
 * caused it are one durable operation. Mirrors `preparedDeliveryWriter` in communications.
 */
export const preparedAuditWriter =
  (database: Database): PreparedAuditWriter<Statement> =>
  (prepared) => [database.prepare(APPEND).bind(...bindings(prepared))];

/** The in-memory twin the service suites drive, following the `memory-*` convention. */
export class MemoryAuditRecordStore implements AuditRecordStore {
  private readonly rows: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<boolean> {
    const taken = this.rows.some(
      (row) =>
        row.organizationId === record.organizationId &&
        row.idempotencyKey === record.idempotencyKey,
    );
    if (!taken) this.rows.push(record);
    return !taken;
  }

  async page(
    eventId: string,
    page: { limit: number; before?: { occurredAt: string; id: string } },
  ): Promise<{ items: readonly AuditRecord[]; hasMore: boolean }> {
    const ordered = this.rows
      .filter((row) => row.eventId === eventId)
      /*
       * Binary comparison, not `localeCompare`. SQLite's TEXT collation is BINARY, and the cursor
       * filter below uses JS `<`, which is also binary — a twin that *sorted* by locale would
       * disagree with D1 the first time an id or an instant varied in case, while every service
       * suite driving the twin kept passing.
       */
      .toSorted((left, right) => {
        if (left.occurredAt !== right.occurredAt)
          return left.occurredAt < right.occurredAt ? 1 : -1;
        return left.id < right.id ? 1 : -1;
      });
    const after = page.before
      ? ordered.filter(
          (row) =>
            row.occurredAt < (page.before?.occurredAt ?? "") ||
            (row.occurredAt === page.before?.occurredAt && row.id < page.before.id),
        )
      : ordered;
    return { items: after.slice(0, page.limit), hasMore: after.length > page.limit };
  }
}
