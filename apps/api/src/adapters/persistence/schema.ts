import { sql } from "drizzle-orm";
import { check, index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export const contentSessions = sqliteTable("content_sessions", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  proposalId: text("proposal_id").notNull(),
  title: text("title").notNull(),
  abstract: text("abstract").notNull(),
  format: text("format").notNull(),
  speakerProfileIds: text("speaker_profile_ids").notNull(),
  tags: text("tags").notNull(),
  tracks: text("tracks").notNull(),
  publicationState: text("publication_state").notNull(),
  scheduleStartsAt: text("schedule_starts_at"),
  scheduleEndsAt: text("schedule_ends_at"),
  scheduleLocation: text("schedule_location"),
});
export const speakerProfiles = sqliteTable("speaker_profiles", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  sourcePersonId: text("source_person_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  bio: text("bio").notNull(),
  pronouns: text("pronouns").notNull(),
  organization: text("organization").notNull(),
  photoAssetId: text("photo_asset_id"),
});
export const speakerTasks = sqliteTable("speaker_tasks", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  speakerProfileId: text("speaker_profile_id")
    .notNull()
    .references(() => speakerProfiles.id),
  title: text("title").notNull(),
  dueAt: text("due_at").notNull(),
  status: text("status").notNull(),
  completedAt: text("completed_at"),
});
export const speakerAssets = sqliteTable("speaker_assets", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  speakerProfileId: text("speaker_profile_id")
    .notNull()
    .references(() => speakerProfiles.id),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull(),
  visibility: text("visibility").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
});
export const speakerMessages = sqliteTable("speaker_messages", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  speakerProfileId: text("speaker_profile_id")
    .notNull()
    .references(() => speakerProfiles.id),
  subject: text("subject").notNull(),
  sentAt: text("sent_at").notNull(),
});
