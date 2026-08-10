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

// @spec PRD-COM-001 PRD-INT-001
export const messageTemplates = sqliteTable(
  "message_templates",
  {
    id: text("id").primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    templateKey: text("template_key").notNull(),
    version: integer("version").notNull(),
    channel: text("channel").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [unique().on(table.organizationId, table.templateKey, table.version)],
);

export const communicationDeliveries = sqliteTable(
  "communication_deliveries",
  {
    id: text("id").primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    idempotencyKey: text("idempotency_key").notNull(),
    triggerType: text("trigger_type").notNull(),
    channel: text("channel").notNull(),
    templateId: text("template_id").references(() => messageTemplates.id),
    templateVersion: integer("template_version"),
    recipientRef: text("recipient_ref").notNull(),
    payloadJson: text("payload_json").notNull(),
    projectionVersion: integer("projection_version"),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.organizationId, table.idempotencyKey),
    index("communication_deliveries_worker_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseToken,
    ),
    index("communication_deliveries_event_idx").on(
      table.organizationId,
      table.eventId,
      table.createdAt,
    ),
  ],
);

export const communicationAttempts = sqliteTable(
  "communication_attempts",
  {
    id: text("id").primaryKey().notNull(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => communicationDeliveries.id),
    sequence: integer("sequence").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at").notNull(),
    outcome: text("outcome").notNull(),
    providerReference: text("provider_reference"),
    errorCode: text("error_code"),
  },
  (table) => [
    unique().on(table.deliveryId, table.sequence),
    index("communication_attempts_delivery_idx").on(table.deliveryId, table.sequence),
  ],
);

export const outboundProjectionState = sqliteTable(
  "outbound_projection_state",
  {
    destination: text("destination").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    resourceRef: text("resource_ref").notNull(),
    version: integer("version").notNull(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => communicationDeliveries.id),
    projectedAt: text("projected_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.destination, table.eventId, table.resourceRef] })],
);
