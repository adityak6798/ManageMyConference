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

  /**
   * The last meaningful per-session revision of the schedule in force (issue #141).
   *
   * Derived state, but stored rather than replayed: answering it from `agenda_publications`
   * meant parsing every board an event had ever published on every read that resolves a
   * session's time. Maintained inside the batch that commits the publication, so it can never
   * describe a snapshot that did not commit.
   */
  const agendaSessionSchedules = sqliteTable(
    "agenda_session_schedules",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sessionId: text("session_id").notNull(),
      startsAt: text("starts_at").notNull(),
      endsAt: text("ends_at").notNull(),
      /** The room's name at the publication that set it, or "" if the board had dropped it. */
      location: text("location").notNull(),
      /** The `agenda_publications.version` at which this session last meaningfully moved. */
      revision: integer("revision").notNull(),
      revisedAt: text("revised_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.sessionId] }),
      check("agenda_session_schedules_revision", sql`${table.revision} > 0`),
    ],
  );

  return { agendaDrafts, agendaPublications, agendaSessionSchedules };
}
