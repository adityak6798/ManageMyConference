import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineCfpSchema(references: {
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-CFP-001
  const cfpForms = sqliteTable(
    "cfp_forms",
    {
      eventId: text("event_id")
        .primaryKey()
        .notNull()
        .references(() => references.eventsId),
      title: text("title").notNull(),
      description: text("description").notNull(),
      fieldsJson: text("fields_json").notNull(),
      status: text("status").notNull(),
      version: integer("version").notNull(),
      publishedAt: text("published_at"),
      publishedJson: text("published_json"),
      routingJson: text("routing_json").notNull().default("[]"),
      /**
       * The scheduled submission window, as UTC instants. Live state like `status` rather than
       * part of `published_json`, so extending a deadline publishes no draft form edits — see
       * migration `1201`.
       */
      opensAt: text("opens_at"),
      closesAt: text("closes_at"),
    },
    (table) => [
      check("cfp_forms_title_length", sql`length(${table.title}) BETWEEN 1 AND 120`),
      check("cfp_forms_status", sql`${table.status} IN ('draft', 'open', 'closed')`),
      check("cfp_forms_version", sql`${table.version} > 0`),
    ],
  );
  // @spec PRD-CFP-002
  const cfpSubmissions = sqliteTable(
    "cfp_submissions",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      cfpVersion: integer("cfp_version").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
      answersJson: text("answers_json").notNull(),
      participantsJson: text("participants_json").notNull().default("[]"),
      trackId: text("track_id"),
      formatId: text("format_id"),
      submittedAt: text("submitted_at").notNull(),
      // 0006 added both columns with defaults; D1CfpRepository.createSubmission relies on them.
      status: text("status").notNull().default("submitted"),
      formFieldsJson: text("form_fields_json").notNull().default("[]"),
      resolvedRouteJson: text("resolved_route_json"),
      /** NULL for every anonymous submission: an unowned proposal reaches no dashboard (`1201`). */
      submitterUserId: text("submitter_user_id").references(() => references.usersId),
      lifecycle: text("lifecycle").notNull().default("submitted"),
      /** Optimistic concurrency for one proposal, as `cfp_forms.version` is for the composer. */
      revision: integer("revision").notNull().default(1),
      updatedAt: text("updated_at"),
    },
    (table) => [
      unique("cfp_submissions_event_id_idempotency_key_unique").on(
        table.eventId,
        table.idempotencyKey,
      ),
      check("cfp_submissions_cfp_version", sql`${table.cfpVersion} > 0`),
      check("cfp_submissions_lifecycle", sql`${table.lifecycle} IN ('draft', 'submitted')`),
      check("cfp_submissions_revision", sql`${table.revision} > 0`),
      index("cfp_submissions_event_id_idx").on(table.eventId),
      index("cfp_submissions_event_status_idx").on(table.eventId, table.status),
      index("cfp_submissions_submitter_idx").on(table.submitterUserId, table.eventId),
      index("cfp_submissions_event_lifecycle_idx").on(table.eventId, table.lifecycle),
    ],
  );

  return { cfpForms, cfpSubmissions };
}
