import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export function defineEventsSchema() {
  // @spec PRD-EVT-001
  const organizations = sqliteTable(
    "organizations",
    {
      id: text("id").primaryKey().notNull(),
      name: text("name").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [check("organizations_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`)],
  );

  // @spec PRD-EVT-001
  const events = sqliteTable(
    "events",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organizations.id),
      name: text("name").notNull(),
      timezone: text("timezone").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      check("events_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      index("events_organization_id_idx").on(table.organizationId),
    ],
  );

  return { organizations, events };
}
