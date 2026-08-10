import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// @spec PRD-EVT-001
export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("organizations_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`)],
);

// @spec PRD-IAM-001
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    persona: text("persona").notNull(),
  },
  (table) => [
    check("users_persona", sql`${table.persona} IN ('organizer', 'reviewer', 'speaker', 'public')`),
  ],
);

// @spec PRD-EVT-001
export const events = sqliteTable(
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

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    check("organization_memberships_role", sql`${table.role} = 'organizer'`),
  ],
);

export const eventRoles = sqliteTable(
  "event_roles",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId, table.role] }),
    check("event_roles_role", sql`${table.role} IN ('organizer', 'reviewer', 'speaker', 'public')`),
    index("event_roles_user_id_idx").on(table.userId),
  ],
);

// @spec PRD-CFP-001
export const cfpForms = sqliteTable("cfp_forms", {
  eventId: text("event_id")
    .primaryKey()
    .notNull()
    .references(() => events.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  fieldsJson: text("fields_json").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  publishedAt: text("published_at"),
  publishedJson: text("published_json"),
});
// @spec PRD-CFP-002
export const cfpSubmissions = sqliteTable(
  "cfp_submissions",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    cfpVersion: integer("cfp_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    answersJson: text("answers_json").notNull(),
    submittedAt: text("submitted_at").notNull(),
  },
  (table) => [
    unique("cfp_submissions_event_id_idempotency_key_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("cfp_submissions_event_id_idx").on(table.eventId),
  ],
);
