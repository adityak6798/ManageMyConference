import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineAgendaSchema(references: {
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-AGD-001
  const agendaDrafts = sqliteTable("agenda_drafts", {
    eventId: text("event_id")
      .primaryKey()
      .notNull()
      .references(() => references.eventsId),
    draftJson: text("draft_json").notNull(),
    updatedAt: text("updated_at").notNull(),
    revision: integer("revision").notNull().default(0),
  });

  const agendaPublications = sqliteTable(
    "agenda_publications",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      version: integer("version").notNull(),
      publishedAt: text("published_at").notNull(),
      publishedBy: text("published_by")
        .notNull()
        .references(() => references.usersId),
      scheduleJson: text("schedule_json").notNull(),
      /** Caller-supplied idempotency key; null means "a new intent", not "unknown". */
      commandKey: text("command_key"),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.version] }),
      check("agenda_publications_version", sql`${table.version} > 0`),
      index("agenda_publications_latest_idx").on(table.eventId, desc(table.version)),
      uniqueIndex("agenda_publications_command_key_idx")
        .on(table.eventId, table.commandKey)
        .where(sql`${table.commandKey} IS NOT NULL`),
    ],
  );

  return { agendaDrafts, agendaPublications };
}
