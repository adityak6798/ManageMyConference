import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineCrmSchema(references: {
  eventsId: AnySQLiteColumn;
  speakerProfilesId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-CRM-001
  const crmProspects = sqliteTable(
    "crm_prospects",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      name: text("name").notNull(),
      stage: text("stage").notNull(),
      ownerId: text("owner_id")
        .notNull()
        .references(() => references.usersId),
      nextAction: text("next_action"),
      nextActionAt: text("next_action_at"),
      speakerId: text("speaker_id").references(() => references.speakerProfilesId),
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
  const crmContacts = sqliteTable(
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
  const crmActivities = sqliteTable(
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
        .references(() => references.usersId),
    },
    (table) => [
      check("crm_activities_is_private", sql`${table.isPrivate} IN (0,1)`),
      index("crm_activities_timeline_idx").on(table.prospectId, table.occurredAt),
      uniqueIndex("crm_activities_one_conversion_idx")
        .on(table.prospectId)
        .where(sql`${table.kind} = 'conversion'`),
    ],
  );

  return { crmProspects, crmContacts, crmActivities };
}
