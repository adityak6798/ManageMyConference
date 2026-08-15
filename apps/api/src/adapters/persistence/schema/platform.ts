import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
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

  /*
   * ---- reporting (issue #196) ---------------------------------------------
   *
   * **Nothing here stores report results.** A definition is a question, answered by re-running it
   * through the owning domains' declared read interfaces every time — the same argument
   * `PlatformSearchService` makes about not building an index. See `1902_reporting.sql`.
   */
  // @spec PRD-OPS-004
  const reportDefinitions = sqliteTable(
    "report_definitions",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      /** Recorded as the value it was; an audit-shaped field rather than a pointer. */
      organizationId: text("organization_id").notNull(),
      name: text("name").notNull(),
      description: text("description").notNull().default(""),
      dataset: text("dataset").notNull(),
      /**
       * The whole validated query, as one JSON document.
       *
       * JSON rather than five child tables because it is one value that is only ever read and
       * written whole, and because every part of it is re-validated against the catalogue on the
       * way in and on the way out — nothing here is a query fragment that could reach storage.
       */
      queryJson: text("query_json").notNull(),
      createdBy: text("created_by")
        .notNull()
        .references(() => references.usersId),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      revision: integer("revision").notNull().default(1),
    },
    (table) => [
      check(
        "report_definitions_dataset",
        sql`${table.dataset} IN ('sessions', 'speakers', 'submissions', 'reviews', 'deliverables', 'contacts', 'agenda', 'communications')`,
      ),
      check("report_definitions_query_json", sql`json_valid(${table.queryJson})`),
      check("report_definitions_revision", sql`${table.revision} >= 1`),
      check("report_definitions_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      check("report_definitions_description_length", sql`length(${table.description}) <= 400`),
      uniqueIndex("report_definitions_event_name_idx").on(table.eventId, sql`lower(${table.name})`),
      index("report_definitions_event_idx").on(table.eventId, table.updatedAt),
    ],
  );

  /**
   * The capability-URL convention, shared by every anonymous share link in this product.
   *
   * Declared here rather than per domain so `DEBT-012`'s conditions — expiry, view limit,
   * password, revocation, digest-only storage — are true of all of them at once.
   * `resource_ref` names another domain's row and carries no foreign key, deliberately;
   * `speaker-profile` and `speaker-asset` are declared for issue #189's `GAP-028` residual so
   * that lane adds a resolver rather than a second table. See `1902_reporting.sql`.
   */
  // @spec PRD-OPS-004
  const capabilityLinks = sqliteTable(
    "capability_links",
    {
      id: text("id").primaryKey().notNull(),
      resourceKind: text("resource_kind").notNull(),
      resourceRef: text("resource_ref").notNull(),
      organizationId: text("organization_id").notNull(),
      eventId: text("event_id").notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      passwordHash: text("password_hash"),
      createdBy: text("created_by")
        .notNull()
        .references(() => references.usersId),
      createdAt: text("created_at").notNull(),
      expiresAt: text("expires_at").notNull(),
      viewLimit: integer("view_limit"),
      views: integer("views").notNull().default(0),
      revokedAt: text("revoked_at"),
      scopeJson: text("scope_json").notNull().default("{}"),
    },
    (table) => [
      check(
        "capability_links_resource_kind",
        sql`${table.resourceKind} IN ('report', 'speaker-profile', 'speaker-asset')`,
      ),
      check("capability_links_token_hash", sql`length(${table.tokenHash}) = 64`),
      check(
        "capability_links_password_hash",
        sql`${table.passwordHash} IS NULL OR length(${table.passwordHash}) = 64`,
      ),
      check(
        "capability_links_view_limit",
        sql`${table.viewLimit} IS NULL OR ${table.viewLimit} >= 1`,
      ),
      check("capability_links_views", sql`${table.views} >= 0`),
      check("capability_links_scope_json", sql`json_valid(${table.scopeJson})`),
      index("capability_links_resource_idx").on(
        table.resourceKind,
        table.resourceRef,
        table.createdAt,
      ),
      index("capability_links_expiry_idx")
        .on(table.expiresAt)
        .where(sql`${table.revokedAt} IS NULL`),
    ],
  );

  const reportSchedules = sqliteTable(
    "report_schedules",
    {
      id: text("id").primaryKey().notNull(),
      reportId: text("report_id")
        .notNull()
        .references(() => reportDefinitions.id, { onDelete: "cascade" }),
      cadence: text("cadence").notNull(),
      minuteOfDay: integer("minute_of_day").notNull(),
      dayOfWeek: integer("day_of_week"),
      dayOfMonth: integer("day_of_month"),
      timezone: text("timezone").notNull(),
      recipients: text("recipients").notNull(),
      linkLifetimeHours: integer("link_lifetime_hours").notNull().default(72),
      createdBy: text("created_by")
        .notNull()
        .references(() => references.usersId),
      createdAt: text("created_at").notNull(),
      pausedAt: text("paused_at"),
      /** The occurrence already produced, so a retried tick fires once per occurrence. */
      lastFiredKey: text("last_fired_key"),
    },
    (table) => [
      check("report_schedules_cadence", sql`${table.cadence} IN ('daily', 'weekly', 'monthly')`),
      check("report_schedules_minute_of_day", sql`${table.minuteOfDay} BETWEEN 0 AND 1439`),
      check(
        "report_schedules_day_of_week",
        sql`${table.dayOfWeek} IS NULL OR ${table.dayOfWeek} BETWEEN 0 AND 6`,
      ),
      check(
        "report_schedules_day_of_month",
        sql`${table.dayOfMonth} IS NULL OR ${table.dayOfMonth} BETWEEN 1 AND 28`,
      ),
      check("report_schedules_recipients", sql`json_valid(${table.recipients})`),
      check(
        "report_schedules_link_lifetime_hours",
        sql`${table.linkLifetimeHours} BETWEEN 1 AND 720`,
      ),
      check(
        "report_schedules_cadence_shape",
        sql`(${table.cadence} = 'daily' AND ${table.dayOfWeek} IS NULL AND ${table.dayOfMonth} IS NULL) OR (${table.cadence} = 'weekly' AND ${table.dayOfWeek} IS NOT NULL AND ${table.dayOfMonth} IS NULL) OR (${table.cadence} = 'monthly' AND ${table.dayOfWeek} IS NULL AND ${table.dayOfMonth} IS NOT NULL)`,
      ),
      index("report_schedules_report_idx").on(table.reportId),
      index("report_schedules_active_idx").on(table.pausedAt, table.cadence),
    ],
  );

  /** Append-only; the unique occurrence key is what turns a retried tick into one delivery. */
  const reportRuns = sqliteTable(
    "report_runs",
    {
      id: text("id").primaryKey().notNull(),
      scheduleId: text("schedule_id")
        .notNull()
        .references(() => reportSchedules.id, { onDelete: "cascade" }),
      occurrenceKey: text("occurrence_key").notNull(),
      ranAt: text("ran_at").notNull(),
      outcome: text("outcome").notNull(),
      detail: text("detail").notNull().default(""),
    },
    (table) => [
      check("report_runs_outcome", sql`${table.outcome} IN ('delivered', 'failed')`),
      unique("report_runs_schedule_id_occurrence_key_unique").on(
        table.scheduleId,
        table.occurrenceKey,
      ),
      index("report_runs_time_idx").on(table.scheduleId, table.ranAt),
    ],
  );

  return {
    platformInboxDismissals,
    platformAuditRecords,
    capabilityLinks,
    reportDefinitions,
    reportSchedules,
    reportRuns,
  };
}
