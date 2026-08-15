import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  primaryKey,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * Platform's own storage, which is deliberately almost nothing.
 *
 * The operational inbox derives every item from the owning domains' reads on each request, so
 * there is no work queue here to keep in step with the world. What cannot be derived is one
 * person's decision to stop being shown an occurrence, and that is the single table below.
 */
export function definePlatformSchema(references: {
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-OPS-002
  const platformInboxDismissals = sqliteTable(
    "platform_inbox_dismissals",
    {
      /** Cascades: a dismissal has nothing to say once its event is gone. See migration 1900. */
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      /**
       * Identity *and* occurrence, as an opaque string.
       *
       * Not a foreign key, and it cannot be one: the conditions it names live in five other
       * domains, and a reference into any of them would be platform holding a pointer at another
       * domain's row. The key carries the occurrence — a deadline, an attempt count — so a
       * re-derived identical item stays dismissed while a new occurrence comes back.
       */
      itemKey: text("item_key").notNull(),
      actorId: text("actor_id")
        .notNull()
        .references(() => references.usersId, { onDelete: "cascade" }),
      dismissedAt: text("dismissed_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.itemKey, table.actorId] }),
      index("platform_inbox_dismissals_event_actor_idx").on(table.eventId, table.actorId),
    ],
  );

  /**
   * The unified audit timeline. Append-only, and structurally so — see migration `1901` for the
   * two triggers that refuse an UPDATE and a DELETE.
   *
   * No column here references another table, which Drizzle cannot express as an absence and so
   * is worth saying twice: an audit record must outlive the thing it describes, so the ids are
   * recorded as the values they were rather than as pointers at rows that may be gone.
   */
  // @spec PRD-OPS-003
  const platformAuditRecords = sqliteTable(
    "platform_audit_records",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id").notNull(),
      eventId: text("event_id").notNull(),
      occurredAt: text("occurred_at").notNull(),
      /** Null for a record nobody signed; `actorName` still says what it was. */
      actorId: text("actor_id"),
      actorName: text("actor_name").notNull(),
      source: text("source").notNull(),
      action: text("action").notNull(),
      targetType: text("target_type").notNull(),
      targetId: text("target_id").notNull(),
      correlationId: text("correlation_id"),
      idempotencyKey: text("idempotency_key").notNull(),
      /** Added by `1902`; declaration order follows the deployed ALTER TABLE history. */
      targetVersion: integer("target_version"),
    },
    (table) => [
      check(
        "platform_audit_records_source",
        sql`${table.source} IN ('human', 'api', 'agent', 'system')`,
      ),
      unique("platform_audit_records_organization_id_idempotency_key_unique").on(
        table.organizationId,
        table.idempotencyKey,
      ),
      index("platform_audit_records_event_occurred_idx").on(
        table.eventId,
        table.occurredAt,
        table.id,
      ),
    ],
  );

  return { platformInboxDismissals, platformAuditRecords };
}
