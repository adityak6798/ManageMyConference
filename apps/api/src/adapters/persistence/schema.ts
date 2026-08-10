import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// @spec PRD-EVT-001
export const events = sqliteTable("events", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  createdAt: text("created_at").notNull(),
});
