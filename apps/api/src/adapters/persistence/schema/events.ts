import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
      /**
       * What provisioned this event, for the one kind of event nobody asked for by name.
       *
       * Null on every event an organizer created. Set only by the events domain's own
       * provisioning paths, where a second concurrent writer must lose rather than create a
       * duplicate (issue #164).
       */
      provisioningKey: text("provisioning_key"),
    },
    (table) => [
      check("events_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      index("events_organization_id_idx").on(table.organizationId),
      uniqueIndex("events_provisioning_key_idx")
        .on(table.organizationId, table.provisioningKey)
        .where(sql`${table.provisioningKey} IS NOT NULL`),
    ],
  );

  // @spec PRD-EVT-002
  const eventTemplates = sqliteTable(
    "event_templates",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organizations.id),
      name: text("name").notNull(),
      state: text("state").notNull(),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      check("event_templates_state", sql`${table.state} IN ('active', 'archived')`),
      check("event_templates_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      // Archiving retires a template, so an archived row must not keep its name reserved.
      uniqueIndex("event_templates_active_name_idx")
        .on(table.organizationId, table.name)
        .where(sql`${table.state} = 'active'`),
      index("event_templates_organization_idx").on(table.organizationId, table.state),
    ],
  );

  /**
   * One immutable capture of a source event's configuration.
   *
   * `created_by` holds a user id and declares no reference, because this fragment is
   * constructed before identity-access's — identity-access's tables reference `events` and
   * `organizations`, so a reference back to `users` would be a cycle the registry cannot build.
   * The migration matches: it records provenance without pretending to enforce it.
   */
  // @spec PRD-EVT-002
  const eventTemplateVersions = sqliteTable(
    "event_template_versions",
    {
      id: text("id").primaryKey().notNull(),
      templateId: text("template_id")
        .notNull()
        .references(() => eventTemplates.id),
      version: integer("version").notNull(),
      sourceEventId: text("source_event_id")
        .notNull()
        .references(() => events.id),
      payloadJson: text("payload_json").notNull(),
      createdAt: text("created_at").notNull(),
      createdBy: text("created_by").notNull(),
    },
    (table) => [
      check("event_template_versions_version", sql`${table.version} > 0`),
      check("event_template_versions_payload", sql`json_valid(${table.payloadJson})`),
      unique().on(table.templateId, table.version),
    ],
  );

  /**
   * Which template version an event was configured from.
   *
   * The pair is unique, which is both the stored answer to "which version did this event come
   * from" and the guard that makes re-applying converge instead of accumulating rows.
   * `applied_at` and `outcome_json` describe the most recent application of that pair.
   */
  // @spec PRD-EVT-002
  const eventTemplateApplications = sqliteTable(
    "event_template_applications",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => events.id),
      templateVersionId: text("template_version_id")
        .notNull()
        .references(() => eventTemplateVersions.id),
      appliedAt: text("applied_at").notNull(),
      appliedBy: text("applied_by").notNull(),
      outcomeJson: text("outcome_json").notNull(),
    },
    (table) => [
      check("event_template_applications_outcome", sql`json_valid(${table.outcomeJson})`),
      unique().on(table.eventId, table.templateVersionId),
      index("event_template_applications_event_idx").on(table.eventId, table.appliedAt),
    ],
  );

  return {
    organizations,
    events,
    eventTemplates,
    eventTemplateVersions,
    eventTemplateApplications,
  };
}
