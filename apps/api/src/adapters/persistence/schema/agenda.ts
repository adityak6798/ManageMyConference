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

  /*
   * ---- generated drafts (issue #192's residual generation epic) ------------
   *
   * A candidate arrangement, never the board. `board_revision` is what makes a comparison
   * honest: a draft generated against a board two edits ago is a diff against something that no
   * longer exists, and saying so is the point. See `1603_agenda_generation.sql`.
   */
  // @spec PRD-AGD-001
  const agendaGeneratedDrafts = sqliteTable(
    "agenda_generated_drafts",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      name: text("name").notNull(),
      boardRevision: integer("board_revision").notNull(),
      /** Copied at generation time: the library is editable, and a draft must not re-explain. */
      criteriaJson: text("criteria_json").notNull(),
      placementsJson: text("placements_json").notNull(),
      unplacedJson: text("unplaced_json").notNull().default("[]"),
      generatedBy: text("generated_by")
        .notNull()
        .references(() => references.usersId),
      generatedAt: text("generated_at").notNull(),
      status: text("status").notNull().default("proposed"),
      acceptedAt: text("accepted_at"),
    },
    (table) => [
      check("agenda_generated_drafts_criteria_json", sql`json_valid(${table.criteriaJson})`),
      check("agenda_generated_drafts_placements_json", sql`json_valid(${table.placementsJson})`),
      check("agenda_generated_drafts_unplaced_json", sql`json_valid(${table.unplacedJson})`),
      check(
        "agenda_generated_drafts_status",
        sql`${table.status} IN ('proposed', 'accepted', 'discarded')`,
      ),
      check("agenda_generated_drafts_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      check(
        "agenda_generated_drafts_accepted_at",
        sql`(${table.status} = 'accepted') = (${table.acceptedAt} IS NOT NULL)`,
      ),
      index("agenda_generated_drafts_event_idx").on(table.eventId, table.generatedAt),
    ],
  );

  /** The criteria library, in priority order. `position` is the priority; earlier is stronger. */
  const agendaGenerationCriteria = sqliteTable(
    "agenda_generation_criteria",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      criterion: text("criterion").notNull(),
      position: integer("position").notNull(),
      enabled: integer("enabled").notNull().default(1),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.criterion] }),
      check(
        "agenda_generation_criteria_criterion",
        sql`${table.criterion} IN ('avoid-speaker-clash', 'respect-speaker-availability', 'keep-track-together', 'spread-tracks-across-rooms', 'prefer-earlier-slots', 'balance-room-load')`,
      ),
      check("agenda_generation_criteria_position", sql`${table.position} >= 0`),
      check("agenda_generation_criteria_enabled", sql`${table.enabled} IN (0, 1)`),
      index("agenda_generation_criteria_order_idx").on(table.eventId, table.position),
    ],
  );

  /**
   * When a speaker cannot be scheduled — a window rather than a flag.
   *
   * `speaker_id` names an identity this domain does not own and carries no foreign key, the same
   * choice `agenda_session_schedules` makes about session ids.
   */
  const agendaSpeakerAvailability = sqliteTable(
    "agenda_speaker_availability",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      speakerId: text("speaker_id").notNull(),
      startsAt: text("starts_at").notNull(),
      endsAt: text("ends_at").notNull(),
      kind: text("kind").notNull(),
      note: text("note").notNull().default(""),
    },
    (table) => [
      primaryKey({
        columns: [table.eventId, table.speakerId, table.startsAt, table.endsAt, table.kind],
      }),
      check("agenda_speaker_availability_kind", sql`${table.kind} IN ('available', 'unavailable')`),
      check("agenda_speaker_availability_window", sql`${table.endsAt} > ${table.startsAt}`),
      check("agenda_speaker_availability_note_length", sql`length(${table.note}) <= 200`),
      index("agenda_speaker_availability_event_idx").on(table.eventId, table.speakerId),
    ],
  );

  return {
    agendaDrafts,
    agendaPublications,
    agendaSessionSchedules,
    agendaScheduleMaterializations,
    agendaGeneratedDrafts,
    agendaGenerationCriteria,
    agendaSpeakerAvailability,
  };
}
