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

  /**
   * Whether `agendaSessionSchedules` still describes the publication history (issue #169).
   *
   * Two watermarks that are equal exactly when the derived table is current. `publicationWatermark`
   * is advanced by a trigger on every insert into `agenda_publications`, so it moves for writers
   * the application never sees — the old Worker during a deploy, an import, a fixture — and
   * `materializedWatermark` moves only when the fold that derives the table has run. Neither the
   * triggers nor their delete counterpart can be declared here, which is why they are listed in
   * `UNMODELLED_OBJECTS` in `tools/check-schema-drift.mjs`.
   *
   * `materializedWatermark` is nullable and NULL means "never derived", which is what migration
   * `1602` deliberately backfills: it will not claim `1601` caught a publication that landed
   * between the two migrations.
   */
  const agendaScheduleMaterializations = sqliteTable(
    "agenda_schedule_materializations",
    {
      eventId: text("event_id")
        .primaryKey()
        .notNull()
        .references(() => references.eventsId),
      publicationWatermark: integer("publication_watermark").notNull(),
      materializedWatermark: integer("materialized_watermark"),
      materializedAt: text("materialized_at"),
    },
    (table) => [
      check("agenda_schedule_materializations_publication", sql`${table.publicationWatermark} > 0`),
      check(
        "agenda_schedule_materializations_materialized",
        sql`${table.materializedWatermark} > 0`,
      ),
      // Only the drifted events, so the one-minute sweep scans what it is going to repair.
      index("agenda_schedule_materializations_drifted_idx")
        .on(table.eventId)
        .where(sql`${table.materializedWatermark} IS NOT ${table.publicationWatermark}`),
    ],
  );

  return {
    agendaDrafts,
    agendaPublications,
    agendaSessionSchedules,
    agendaScheduleMaterializations,
  };
}
