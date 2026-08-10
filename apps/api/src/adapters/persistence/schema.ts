import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// @spec PRD-EVT-001
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

// @spec PRD-IAM-001
export const users = sqliteTable("users", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  persona: text("persona").notNull(),
});

// @spec PRD-EVT-001
export const events = sqliteTable("events", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  createdAt: text("created_at").notNull(),
});

export const organizationMemberships = sqliteTable("organization_memberships", {
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});

export const eventRoles = sqliteTable("event_roles", {
  eventId: text("event_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});
