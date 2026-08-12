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

export function defineCfpSchema(references: { eventsId: AnySQLiteColumn }) {
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
      submittedAt: text("submitted_at").notNull(),
      // 0006 added both columns with defaults; D1CfpRepository.createSubmission relies on them.
      status: text("status").notNull().default("submitted"),
      formFieldsJson: text("form_fields_json").notNull().default("[]"),
    },
    (table) => [
      unique("cfp_submissions_event_id_idempotency_key_unique").on(
        table.eventId,
        table.idempotencyKey,
      ),
      check("cfp_submissions_cfp_version", sql`${table.cfpVersion} > 0`),
      index("cfp_submissions_event_id_idx").on(table.eventId),
      index("cfp_submissions_event_status_idx").on(table.eventId, table.status),
    ],
  );

  return { cfpForms, cfpSubmissions };
}
