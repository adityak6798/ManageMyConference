import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// This file is the declared storage intent for the migrations in `apps/api/migrations`.
// `npm run schema:check` (tools/check-schema-drift.mjs) fails the build when the two disagree.
// Column order matters to that check, so columns appear here in the order the migrations
// create them (including columns added later by ALTER TABLE).

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
export const contentSessions = sqliteTable(
  "content_sessions",
  {
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
  },
  (table) => [
    // Idempotency guard for ContentService.accept under concurrency.
    unique("content_sessions_event_id_proposal_id_unique").on(table.eventId, table.proposalId),
    check(
      "content_sessions_publication_state",
      sql`${table.publicationState} IN ('draft','ready','published')`,
    ),
    index("content_sessions_event_id_idx").on(table.eventId),
  ],
);
export const speakerProfiles = sqliteTable(
  "speaker_profiles",
  {
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
  },
  (table) => [
    unique("speaker_profiles_event_id_source_person_id_unique").on(
      table.eventId,
      table.sourcePersonId,
    ),
    index("speaker_profiles_event_user_idx").on(table.eventId, table.userId),
  ],
);
export const speakerTasks = sqliteTable(
  "speaker_tasks",
  {
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
  },
  (table) => [
    check("speaker_tasks_status", sql`${table.status} IN ('open','complete')`),
    index("speaker_tasks_profile_idx").on(table.speakerProfileId),
  ],
);
export const speakerAssets = sqliteTable(
  "speaker_assets",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    speakerProfileId: text("speaker_profile_id")
      .notNull()
      .references(() => speakerProfiles.id),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    visibility: text("visibility").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
  },
  (table) => [
    check("speaker_assets_visibility", sql`${table.visibility} IN ('private','publishable')`),
    index("speaker_assets_profile_idx").on(table.speakerProfileId),
  ],
);
export const speakerMessages = sqliteTable(
  "speaker_messages",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    speakerProfileId: text("speaker_profile_id")
      .notNull()
      .references(() => speakerProfiles.id),
    subject: text("subject").notNull(),
    sentAt: text("sent_at").notNull(),
  },
  (table) => [index("speaker_messages_profile_idx").on(table.speakerProfileId)],
);
// @spec PRD-CFP-001
export const cfpForms = sqliteTable(
  "cfp_forms",
  {
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
  },
  (table) => [
    check("cfp_forms_title_length", sql`length(${table.title}) BETWEEN 1 AND 120`),
    check("cfp_forms_status", sql`${table.status} IN ('draft', 'open', 'closed')`),
    check("cfp_forms_version", sql`${table.version} > 0`),
  ],
);
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
    // 0006 added both columns with defaults; D1CfpRepository.createSubmission relies on them.
    status: text("status").notNull().default("submitted"),
    formFieldsJson: text("form_fields_json").notNull().default("[]"),
  },
  (table) => [
    unique("cfp_submissions_event_id_idempotency_key_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    check("cfp_submissions_cfp_version", sql`${table.cfpVersion} > 0`),
    index("cfp_submissions_event_id_idx").on(table.eventId),
    index("cfp_submissions_event_status_idx").on(table.eventId, table.status),
  ],
);
// @spec PRD-ABS-001 PRD-REV-001
export const cfpStatusAudit = sqliteTable(
  "cfp_status_audit",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => cfpSubmissions.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("cfp_status_audit_event_idx").on(table.eventId, table.occurredAt)],
);
export const cfpStatuses = sqliteTable(
  "cfp_statuses",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.key] })],
);
export const reviewPlans = sqliteTable("review_plans", {
  eventId: text("event_id")
    .primaryKey()
    .notNull()
    .references(() => events.id),
  criteriaJson: text("criteria_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => cfpSubmissions.id),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("review_assignment_unique").on(table.eventId, table.proposalId, table.reviewerId),
    index("review_assignments_reviewer_idx").on(table.eventId, table.reviewerId),
  ],
);
export const reviewConflicts = sqliteTable(
  "review_conflicts",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => reviewAssignments.id),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    declaredAt: text("declared_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.reviewerId] })],
);
export const reviewEvaluations = sqliteTable(
  "review_evaluations",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => reviewAssignments.id),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => users.id),
    scoresJson: text("scores_json").notNull(),
    notes: text("notes").notNull(),
    state: text("state").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.assignmentId, table.reviewerId] }),
    check("review_evaluations_state", sql`${table.state} IN ('draft', 'completed')`),
  ],
);
export const reviewOutcomes = sqliteTable(
  "review_outcomes",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => cfpSubmissions.id),
    completedEvaluationCount: integer("completed_evaluation_count").notNull(),
    averageScore: real("average_score").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.proposalId] })],
);
// The organizer's acceptance decision. `cfp_submissions.status` carries the workflow state the
// triage board filters on and organizers may rename; this row is the durable record of who
// decided what and when, and it is what content acceptance is gated on (`ARC-FLOW-001`).
export const reviewDecisions = sqliteTable(
  "review_decisions",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => cfpSubmissions.id),
    outcome: text("outcome").notNull(),
    decidedBy: text("decided_by")
      .notNull()
      .references(() => users.id),
    decidedAt: text("decided_at").notNull(),
    note: text("note").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.proposalId] }),
    check("review_decisions_outcome", sql`${table.outcome} IN ('accepted', 'declined')`),
    index("review_decisions_event_outcome_idx").on(table.eventId, table.outcome),
  ],
);
export const reviewEvents = sqliteTable(
  "review_events",
  {
    id: text("id").primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    version: integer("version").notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id").notNull(),
  },
  (table) => [
    unique("review_event_assignment_version_unique").on(
      table.eventType,
      table.assignmentId,
      table.version,
    ),
    check("review_events_event_type", sql`${table.eventType} = 'EVT-REVIEW-COMPLETED'`),
    check("review_events_version", sql`${table.version} = 1`),
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
    speakerId: text("speaker_id").references(() => speakerProfiles.id),
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
    uniqueIndex("crm_activities_one_conversion_idx")
      .on(table.prospectId)
      .where(sql`${table.kind} = 'conversion'`),
  ],
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
export const speakerConversionClaims = sqliteTable(
  "speaker_conversion_claims",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    speakerId: text("speaker_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.sourceKind, table.sourceId] })],
);
export const speakerEmailClaims = sqliteTable(
  "speaker_email_claims",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    normalizedEmail: text("normalized_email").notNull(),
    speakerId: text("speaker_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.normalizedEmail] })],
);

// @spec PRD-AGD-001
export const agendaDrafts = sqliteTable("agenda_drafts", {
  eventId: text("event_id")
    .primaryKey()
    .notNull()
    .references(() => events.id),
  draftJson: text("draft_json").notNull(),
  updatedAt: text("updated_at").notNull(),
  revision: integer("revision").notNull().default(0),
});

export const agendaPublications = sqliteTable(
  "agenda_publications",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    version: integer("version").notNull(),
    publishedAt: text("published_at").notNull(),
    publishedBy: text("published_by")
      .notNull()
      .references(() => users.id),
    scheduleJson: text("schedule_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.version] }),
    check("agenda_publications_version", sql`${table.version} > 0`),
    index("agenda_publications_latest_idx").on(table.eventId, desc(table.version)),
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
  (table) => [
    unique().on(table.organizationId, table.templateKey, table.version),
    check("message_templates_version", sql`${table.version} > 0`),
    check(
      "message_templates_channel",
      sql`${table.channel} IN ('email', 'airtable', 'accelevents')`,
    ),
  ],
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
    check(
      "communication_attempts_outcome",
      sql`${table.outcome} IN ('succeeded', 'retryable_failure', 'terminal_failure')`,
    ),
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
  (table) => [
    primaryKey({ columns: [table.destination, table.eventId, table.resourceRef] }),
    check(
      "outbound_projection_state_destination",
      sql`${table.destination} IN ('airtable', 'accelevents')`,
    ),
    check("outbound_projection_state_version", sql`${table.version} > 0`),
  ],
);

// @spec PRD-PUB-001
export const publicEventProjections = sqliteTable(
  "public_event_projections",
  {
    eventId: text("event_id")
      .primaryKey()
      .notNull()
      .references(() => events.id),
    slug: text("slug").notNull().unique(),
    state: text("state").notNull(),
    draftJson: text("draft_json").notNull(),
    publishedJson: text("published_json"),
    publishedAt: text("published_at"),
  },
  (table) => [
    check("public_event_projections_slug_length", sql`length(${table.slug}) BETWEEN 1 AND 120`),
    check(
      "public_event_projections_state",
      sql`${table.state} IN ('draft', 'published', 'unpublished')`,
    ),
    check("public_event_projections_draft_json", sql`json_valid(${table.draftJson})`),
    check(
      "public_event_projections_published_json",
      sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`,
    ),
    index("public_event_projections_slug_state_idx").on(table.slug, table.state),
  ],
);
