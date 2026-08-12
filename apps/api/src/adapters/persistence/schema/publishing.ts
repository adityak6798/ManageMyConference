import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
      index("public_event_projections_slug_state_idx").on(table.slug, table.state),
    ],
  );

  return { publicEventProjections };
}
