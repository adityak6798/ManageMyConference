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
      // The message as sent, rendered from the pinned template version at enqueue. Null for
      // projection channels, which carry a payload rather than a message, and for any delivery
      // enqueued before migration 1700.
      renderedSubject: text("rendered_subject"),
      renderedBody: text("rendered_body"),
    },
    (table) => [
      unique().on(table.organizationId, table.idempotencyKey),
      // The union both wave-3 communications branches agreed on, so a rebuild in either does not
      // drop the other's values. Five triggers and the `event` channel have no producer here yet;
      // migration 1750's header says why they are permitted anyway. `proposal.submitted` joined it
      // in migration 1705, from the CFP lane that produces it (issue #190).
      check(
        "communication_deliveries_trigger_type",
        sql`${table.triggerType} IN ('speaker.invited', 'reviewer.assigned', 'reviewer.reminder', 'organizer.digest', 'projection.requested', 'schedule.published', 'speaker.scheduled', 'speaker.task_assigned', 'speaker.task_reminder', 'speaker.calendar_invite', 'decision.recorded', 'proposal.submitted')`,
      ),
      // `event` carries a domain event rather than an outbound call; see migration 1703.
      check(
        "communication_deliveries_channel",
        sql`${table.channel} IN ('email', 'airtable', 'accelevents', 'event')`,
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

  // Last-sync state for the inbound Accelevents registration import. One row per event; a dry run
  // never writes here. See migration 1751 for why this is the only run state kept.
  const accelEventsSyncRuns = sqliteTable(
    "accelevents_sync_runs",
    {
      eventId: text("event_id")
        .primaryKey()
        .notNull()
        .references(() => references.eventsId),
      startedAt: text("started_at").notNull(),
      completedAt: text("completed_at").notNull(),
      outcome: text("outcome").notNull(),
      total: integer("total").notNull(),
      created: integer("created").notNull(),
      skipped: integer("skipped").notNull(),
      invalid: integer("invalid").notNull(),
      errorCode: text("error_code"),
    },
    (table) => [
      check("accelevents_sync_runs_outcome", sql`${table.outcome} IN ('succeeded', 'failed')`),
    ],
  );

  const calendarInviteStates = sqliteTable(
    "calendar_invite_states",
    {
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sessionId: text("session_id").notNull(),
      speakerProfileId: text("speaker_profile_id").notNull(),
      scheduleRef: text("schedule_ref").notNull(),
      recipientRef: text("recipient_ref").notNull(),
      sequence: integer("sequence").notNull(),
      deliveryId: text("delivery_id")
        .notNull()
        .references(() => communicationDeliveries.id),
    },
    (table) => [
      primaryKey({
        columns: [table.organizationId, table.eventId, table.sessionId, table.speakerProfileId],
      }),
      check("calendar_invite_states_sequence", sql`${table.sequence} >= 0`),
      unique().on(table.deliveryId),
    ],
  );

  const webhookSubscriptions = sqliteTable(
    "webhook_subscriptions",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      eventId: text("event_id").references(() => references.eventsId),
      url: text("url").notNull(),
      secretEnvelope: text("secret_envelope").notNull(),
      previousSecretEnvelope: text("previous_secret_envelope"),
      previousSecretExpiresAt: text("previous_secret_expires_at"),
      state: text("state").notNull(),
      createdAt: text("created_at").notNull(),
      disabledAt: text("disabled_at"),
      disabledReason: text("disabled_reason"),
      revision: integer("revision").notNull().default(0),
    },
    (table) => [
      check("webhook_subscriptions_state", sql`${table.state} IN ('active', 'disabled')`),
    ],
  );
  const webhookSubscriptionEventTypes = sqliteTable(
    "webhook_subscription_event_types",
    {
      subscriptionId: text("subscription_id")
        .notNull()
        .references(() => webhookSubscriptions.id),
      eventType: text("event_type").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.subscriptionId, table.eventType] }),
      check(
        "webhook_subscription_event_types_type",
        sql`${table.eventType} IN ('schedule.published')`,
      ),
    ],
  );
  const webhookDeliveries = sqliteTable(
    "webhook_deliveries",
    {
      id: text("id").primaryKey().notNull(),
      subscriptionId: text("subscription_id")
        .notNull()
        .references(() => webhookSubscriptions.id),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      eventId: text("event_id").references(() => references.eventsId),
      eventRecordId: text("event_record_id").notNull(),
      eventType: text("event_type").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
      payloadJson: text("payload_json").notNull(),
      state: text("state").notNull(),
      attemptCount: integer("attempt_count").notNull().default(0),
      nextAttemptAt: text("next_attempt_at").notNull(),
      leaseToken: text("lease_token"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      unique().on(table.subscriptionId, table.idempotencyKey),
      check("webhook_deliveries_event_type", sql`${table.eventType} IN ('schedule.published')`),
      check("webhook_deliveries_payload_json", sql`json_valid(${table.payloadJson})`),
      check(
        "webhook_deliveries_state",
        sql`${table.state} IN ('queued', 'retrying', 'succeeded', 'terminal')`,
      ),
      index("webhook_deliveries_worker_idx").on(table.state, table.nextAttemptAt, table.leaseToken),
      index("webhook_deliveries_history_idx").on(table.subscriptionId, table.createdAt, table.id),
    ],
  );
  const webhookDeliveryAttempts = sqliteTable(
    "webhook_delivery_attempts",
    {
      id: text("id").primaryKey().notNull(),
      deliveryId: text("delivery_id")
        .notNull()
        .references(() => webhookDeliveries.id),
      sequence: integer("sequence").notNull(),
      startedAt: text("started_at").notNull(),
      completedAt: text("completed_at").notNull(),
      outcome: text("outcome").notNull(),
      errorCode: text("error_code"),
      // Actor identifiers include users and API clients; issue #99 owns source projection.
      requestedBy: text("requested_by"),
    },
    (table) => [
      unique().on(table.deliveryId, table.sequence),
      check(
        "webhook_delivery_attempts_outcome",
        sql`${table.outcome} IN ('succeeded', 'retryable_failure', 'terminal_failure')`,
      ),
      index("webhook_delivery_attempts_delivery_idx").on(table.deliveryId, table.sequence),
    ],
  );
  const webhookIdempotencyRecords = sqliteTable(
    "webhook_idempotency_records",
    {
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      idempotencyKey: text("idempotency_key").notNull(),
      operation: text("operation").notNull(),
      requestHash: text("request_hash").notNull(),
      responseEnvelope: text("response_envelope").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.idempotencyKey] }),
      check(
        "webhook_idempotency_records_operation",
        sql`${table.operation} IN ('create', 'update', 'disable', 'rotate', 'replay')`,
      ),
    ],
  );

  return {
    messageTemplates,
    communicationDeliveries,
    communicationAttempts,
    outboundProjectionState,
    accelEventsSyncRuns,
    calendarInviteStates,
    webhookSubscriptions,
    webhookSubscriptionEventTypes,
    webhookDeliveries,
    webhookDeliveryAttempts,
    webhookIdempotencyRecords,
  };
}
