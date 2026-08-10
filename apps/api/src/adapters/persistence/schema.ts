import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
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

// @spec PRD-CRM-001
export const crmProspects = sqliteTable(
  "crm_prospects",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    name: text("name").notNull(),
    stage: text("stage").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    nextAction: text("next_action"),
    nextActionAt: text("next_action_at"),
    speakerId: text("speaker_id"),
    convertedAt: text("converted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("crm_prospects_name_length", sql`length(${table.name}) BETWEEN 1 AND 160`),
    check(
      "crm_prospects_stage",
      sql`${table.stage} IN ('identified','contacted','engaged','invited','converted')`,
    ),
    index("crm_prospects_event_pipeline_idx").on(table.eventId, table.stage, table.nextActionAt),
  ],
);
export const crmContacts = sqliteTable(
  "crm_contacts",
  {
    id: text("id").primaryKey().notNull(),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => crmProspects.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
  },
  (table) => [
    check("crm_contacts_is_primary", sql`${table.isPrimary} IN (0,1)`),
    index("crm_contacts_prospect_idx").on(table.prospectId),
  ],
);
export const crmActivities = sqliteTable(
  "crm_activities",
  {
    id: text("id").primaryKey().notNull(),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => crmProspects.id),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull(),
    occurredAt: text("occurred_at").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    check("crm_activities_is_private", sql`${table.isPrivate} IN (0,1)`),
    index("crm_activities_timeline_idx").on(table.prospectId, table.occurredAt),
  ],
);

// @spec PRD-SPK-001 ARC-FLOW-003
export const speakerProfiles = sqliteTable(
  "speaker_profiles",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
  },
  (table) => [uniqueIndex("speaker_profiles_event_email_idx").on(table.eventId, table.email)],
);
export const speakerConversionSources = sqliteTable(
  "speaker_conversion_sources",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    speakerId: text("speaker_id")
      .notNull()
      .references(() => speakerProfiles.id),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.sourceKind, table.sourceId] })],
);
