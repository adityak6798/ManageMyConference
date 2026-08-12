import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineCommunicationsIntegrationsSchema(references: {
  eventsId: AnySQLiteColumn;
  organizationsId: AnySQLiteColumn;
}) {
  // @spec PRD-COM-001 PRD-INT-001
  const messageTemplates = sqliteTable(
    "message_templates",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      templateKey: text("template_key").notNull(),
      version: integer("version").notNull(),
      channel: text("channel").notNull(),
      subject: text("subject"),
      body: text("body").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      unique().on(table.organizationId, table.templateKey, table.version),
      check("message_templates_version", sql`${table.version} > 0`),
      check(
        "message_templates_channel",
        sql`${table.channel} IN ('email', 'airtable', 'accelevents')`,
      ),
    ],
  );

  const communicationDeliveries = sqliteTable(
    "communication_deliveries",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
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
      check(
        "communication_deliveries_trigger_type",
        sql`${table.triggerType} IN ('speaker.invited', 'reviewer.assigned', 'organizer.digest', 'projection.requested')`,
      ),
      check(
        "communication_deliveries_channel",
        sql`${table.channel} IN ('email', 'airtable', 'accelevents')`,
      ),
      check("communication_deliveries_payload_json", sql`json_valid(${table.payloadJson})`),
      check(
        "communication_deliveries_state",
        sql`${table.state} IN ('queued', 'retrying', 'succeeded', 'terminal')`,
      ),
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

  const communicationAttempts = sqliteTable(
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
      check(
        "communication_attempts_outcome",
        sql`${table.outcome} IN ('succeeded', 'retryable_failure', 'terminal_failure')`,
      ),
      index("communication_attempts_delivery_idx").on(table.deliveryId, table.sequence),
    ],
  );

  const outboundProjectionState = sqliteTable(
    "outbound_projection_state",
    {
      destination: text("destination").notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      resourceRef: text("resource_ref").notNull(),
      version: integer("version").notNull(),
      deliveryId: text("delivery_id")
        .notNull()
        .references(() => communicationDeliveries.id),
      projectedAt: text("projected_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.destination, table.eventId, table.resourceRef] }),
      check(
        "outbound_projection_state_destination",
        sql`${table.destination} IN ('airtable', 'accelevents')`,
      ),
      check("outbound_projection_state_version", sql`${table.version} > 0`),
    ],
  );

  return {
    messageTemplates,
    communicationDeliveries,
    communicationAttempts,
    outboundProjectionState,
  };
}
