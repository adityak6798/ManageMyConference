import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
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
    formFieldsJson: text("form_fields_json").notNull(),
    submittedAt: text("submitted_at").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    unique("cfp_submissions_event_id_idempotency_key_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("cfp_submissions_event_id_idx").on(table.eventId),
    index("cfp_submissions_event_status_idx").on(table.eventId, table.status),
  ],
);
// @spec PRD-ABS-001 PRD-REV-001
export const cfpStatusAudit = sqliteTable(
  "cfp_status_audit",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => cfpSubmissions.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorId: text("actor_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("cfp_status_audit_event_idx").on(table.eventId, table.occurredAt)],
);
export const cfpStatuses = sqliteTable(
  "cfp_statuses",
  {
    eventId: text("event_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.key] })],
);
export const reviewPlans = sqliteTable("review_plans", {
  eventId: text("event_id").primaryKey().notNull(),
  criteriaJson: text("criteria_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: text("id").primaryKey().notNull(),
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    reviewerId: text("reviewer_id").notNull(),
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
    reviewerId: text("reviewer_id").notNull(),
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
    reviewerId: text("reviewer_id").notNull(),
    scoresJson: text("scores_json").notNull(),
    notes: text("notes").notNull(),
    state: text("state").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.reviewerId] })],
);
export const reviewOutcomes = sqliteTable(
  "review_outcomes",
  {
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    completedEvaluationCount: integer("completed_evaluation_count").notNull(),
    averageScore: real("average_score").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.proposalId] })],
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
  ],
);
