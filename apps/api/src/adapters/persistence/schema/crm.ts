import { sql } from "drizzle-orm";
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

export function defineCrmSchema(references: {
  eventsId: AnySQLiteColumn;
  organizationsId: AnySQLiteColumn;
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

  /*
   * The organization-wide directory. Scoped by `organization_id`, never by `event_id`: an
   * event-scoped table could not hold a person who appears at two events once, which is the
   * property `PRD-CRM-001` asks the directory for.
   */
  // @spec PRD-CRM-001
  const crmOrganizationContacts = sqliteTable(
    "crm_organization_contacts",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      name: text("name").notNull(),
      email: text("email").notNull(),
      company: text("company"),
      title: text("title"),
      notes: text("notes"),
      source: text("source").notNull(),
      merged_into_id: text("merged_into_id").references(
        (): AnySQLiteColumn => crmOrganizationContacts.id,
      ),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      check("crm_organization_contacts_name_length", sql`length(${table.name}) BETWEEN 1 AND 160`),
      check(
        "crm_organization_contacts_source",
        sql`${table.source} IN ('manual','import','prospect')`,
      ),
      // Partial: a record that lost a merge keeps its address, and two of them may share one.
      uniqueIndex("crm_organization_contacts_email_idx")
        .on(table.organizationId, table.email)
        .where(sql`${table.merged_into_id} IS NULL`),
      index("crm_organization_contacts_directory_idx").on(
        table.organizationId,
        table.company,
        table.name,
      ),
    ],
  );
  const crmContactTags = sqliteTable(
    "crm_contact_tags",
    {
      contactId: text("contact_id")
        .notNull()
        .references(() => crmOrganizationContacts.id),
      tag: text("tag").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.contactId, table.tag] }),
      index("crm_contact_tags_tag_idx").on(table.tag, table.contactId),
    ],
  );
  const crmContactFields = sqliteTable(
    "crm_contact_fields",
    {
      contactId: text("contact_id")
        .notNull()
        .references(() => crmOrganizationContacts.id),
      fieldKey: text("field_key").notNull(),
      fieldValue: text("field_value").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.contactId, table.fieldKey] }),
      index("crm_contact_fields_lookup_idx").on(table.fieldKey, table.fieldValue),
    ],
  );
  const crmContactAliases = sqliteTable(
    "crm_contact_aliases",
    {
      id: text("id").primaryKey().notNull(),
      contactId: text("contact_id")
        .notNull()
        .references(() => crmOrganizationContacts.id),
      name: text("name").notNull(),
      email: text("email").notNull(),
      mergedFromId: text("merged_from_id").notNull(),
      mergedAt: text("merged_at").notNull(),
    },
    (table) => [
      index("crm_contact_aliases_contact_idx").on(table.contactId),
      index("crm_contact_aliases_email_idx").on(table.email),
    ],
  );
  const crmContactEvents = sqliteTable(
    "crm_contact_events",
    {
      contactId: text("contact_id")
        .notNull()
        .references(() => crmOrganizationContacts.id),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      prospectId: text("prospect_id")
        .notNull()
        .references(() => crmProspects.id),
      linkedAt: text("linked_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.contactId, table.eventId] }),
      // One prospect belongs to at most one directory contact, so a pipeline row cannot be
      // claimed as the history of two different people.
      uniqueIndex("crm_contact_events_prospect_idx").on(table.prospectId),
    ],
  );
  const crmContactActivities = sqliteTable(
    "crm_contact_activities",
    {
      id: text("id").primaryKey().notNull(),
      contactId: text("contact_id")
        .notNull()
        .references(() => crmOrganizationContacts.id),
      kind: text("kind").notNull(),
      summary: text("summary").notNull(),
      isPrivate: integer("is_private", { mode: "boolean" }).notNull(),
      occurredAt: text("occurred_at").notNull(),
      actorId: text("actor_id")
        .notNull()
        .references(() => references.usersId),
    },
    (table) => [
      check("crm_contact_activities_is_private", sql`${table.isPrivate} IN (0,1)`),
      check(
        "crm_contact_activities_kind",
        sql`${table.kind} IN ('note','email','call','meeting','import','merge','outreach','conversion')`,
      ),
      index("crm_contact_activities_timeline_idx").on(table.contactId, table.occurredAt),
    ],
  );
  const crmContactSegments = sqliteTable(
    "crm_contact_segments",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      name: text("name").notNull(),
      definitionJson: text("definition_json").notNull(),
      createdAt: text("created_at").notNull(),
      createdBy: text("created_by")
        .notNull()
        .references(() => references.usersId),
    },
    (table) => [
      check("crm_contact_segments_name_length", sql`length(${table.name}) BETWEEN 1 AND 80`),
      uniqueIndex("crm_contact_segments_name_idx").on(table.organizationId, table.name),
    ],
  );
  const crmContactImports = sqliteTable(
    "crm_contact_imports",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      filename: text("filename").notNull(),
      rowCount: integer("row_count").notNull(),
      createdCount: integer("created_count").notNull(),
      updatedCount: integer("updated_count").notNull(),
      skippedCount: integer("skipped_count").notNull(),
      importedAt: text("imported_at").notNull(),
      importedBy: text("imported_by")
        .notNull()
        .references(() => references.usersId),
    },
    (table) => [
      index("crm_contact_imports_organization_idx").on(table.organizationId, table.importedAt),
    ],
  );

  return {
    crmProspects,
    crmContacts,
    crmActivities,
    crmOrganizationContacts,
    crmContactTags,
    crmContactFields,
    crmContactAliases,
    crmContactEvents,
    crmContactActivities,
    crmContactSegments,
    crmContactImports,
  };
}
