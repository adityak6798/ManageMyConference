import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export function definePublishingSchema(references: { eventsId: AnySQLiteColumn }) {
  // @spec PRD-PUB-001
  const publicEventProjections = sqliteTable(
    "public_event_projections",
    {
      eventId: text("event_id")
        .primaryKey()
        .notNull()
        .references(() => references.eventsId),
      slug: text("slug").notNull().unique(),
      state: text("state").notNull(),
      draftJson: text("draft_json").notNull(),
      publishedJson: text("published_json"),
      publishedAt: text("published_at"),
      projectionVersion: integer("projection_version").notNull().default(0),
      agendaVersion: integer("agenda_version"),
      agendaPublishedAt: text("agenda_published_at"),
      cfpVersion: integer("cfp_version"),
      cfpPublishedAt: text("cfp_published_at"),
      contentDigest: text("content_digest"),
      activationCause: text("activation_cause"),
    },
    (table) => [
      check("public_event_projections_slug_length", sql`length(${table.slug}) BETWEEN 1 AND 120`),
      check(
        "public_event_projections_state",
        sql`${table.state} IN ('draft', 'published', 'unpublished')`,
      ),
      check("public_event_projections_draft_json", sql`json_valid(${table.draftJson})`),
      check(
        "public_event_projections_published_json",
        sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`,
      ),
      check("public_event_projections_version", sql`${table.projectionVersion} >= 0`),
      check(
        "public_event_projections_activation_cause",
        sql`${table.activationCause} IS NULL OR ${table.activationCause} IN ('site-published', 'schedule-published', 'source-reconciled')`,
      ),
      index("public_event_projections_slug_state_idx").on(table.slug, table.state),
      uniqueIndex("public_event_projections_draft_slug_idx").on(
        sql`json_extract(${table.draftJson}, '$.event.slug')`,
      ),
    ],
  );

  // @spec PRD-PUB-001
  const publicEventProjectionVersions = sqliteTable(
    "public_event_projection_versions",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      activatedAt: text("activated_at").notNull(),
      projectionJson: text("projection_json").notNull(),
      agendaVersion: integer("agenda_version"),
      agendaPublishedAt: text("agenda_published_at"),
      cfpVersion: integer("cfp_version"),
      cfpPublishedAt: text("cfp_published_at"),
      contentDigest: text("content_digest"),
      activationCause: text("activation_cause").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.version] }),
      check("public_event_projection_versions_version", sql`${table.version} > 0`),
      check("public_event_projection_versions_json", sql`json_valid(${table.projectionJson})`),
      check(
        "public_event_projection_versions_activation_cause",
        sql`${table.activationCause} IN ('site-published', 'schedule-published', 'source-reconciled')`,
      ),
      index("public_event_projection_versions_activated_idx").on(table.eventId, table.activatedAt),
    ],
  );

  /*
   * An attendee's chosen sessions, addressed by a capability token rather than by a user.
   *
   * `/api/public/*` reads no session and cannot: its `Access-Control-Allow-Origin: *`
   * policy forbids credentials, which is exactly what lets a conference's own site embed
   * the schedule. The token is the identity, only its hash is stored, and the row names
   * sessions by the published projection's public slugs so nothing here can reach past
   * what the organizer published.
   */
  // @spec PRD-PUB-001
  const attendeeItineraries = sqliteTable(
    "attendee_itineraries",
    {
      tokenHash: text("token_hash").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sessionSlugs: text("session_slugs").notNull(),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      check("attendee_itineraries_token_hash", sql`length(${table.tokenHash}) = 64`),
      check("attendee_itineraries_session_slugs", sql`json_valid(${table.sessionSlugs})`),
      index("attendee_itineraries_event_id_idx").on(table.eventId),
      index("attendee_itineraries_empty_updated_at_idx")
        .on(table.updatedAt)
        .where(sql`${table.sessionSlugs} = '[]'`),
    ],
  );

  return { publicEventProjections, publicEventProjectionVersions, attendeeItineraries };
}
