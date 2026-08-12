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
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineReviewSchema(references: {
  cfpSubmissionsId: AnySQLiteColumn;
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-ABS-001 PRD-REV-001
  const cfpStatusAudit = sqliteTable(
    "cfp_status_audit",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      fromStatus: text("from_status").notNull(),
      toStatus: text("to_status").notNull(),
      actorId: text("actor_id")
        .notNull()
        .references(() => references.usersId),
      occurredAt: text("occurred_at").notNull(),
    },
    (table) => [index("cfp_status_audit_event_idx").on(table.eventId, table.occurredAt)],
  );
  const cfpStatuses = sqliteTable(
    "cfp_statuses",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      key: text("key").notNull(),
      label: text("label").notNull(),
      sortOrder: integer("sort_order").notNull(),
    },
    (table) => [primaryKey({ columns: [table.eventId, table.key] })],
  );
  const reviewPlans = sqliteTable("review_plans", {
    eventId: text("event_id")
      .primaryKey()
      .notNull()
      .references(() => references.eventsId),
    criteriaJson: text("criteria_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  });
  const reviewAssignments = sqliteTable(
    "review_assignments",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
      round: integer("round").notNull().default(1),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      check("review_assignments_round", sql`${table.round} > 0`),
      unique("review_assignment_unique").on(
        table.eventId,
        table.proposalId,
        table.reviewerId,
        table.round,
      ),
      index("review_assignments_reviewer_idx").on(table.eventId, table.reviewerId),
    ],
  );
  const reviewAssignmentCaps = sqliteTable(
    "review_assignment_caps",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
      round: integer("round").notNull(),
      assignmentCap: integer("assignment_cap").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.reviewerId, table.round] }),
      check("review_assignment_caps_round", sql`${table.round} > 0`),
      check("review_assignment_caps_cap", sql`${table.assignmentCap} > 0`),
    ],
  );
  const reviewConflicts = sqliteTable(
    "review_conflicts",
    {
      assignmentId: text("assignment_id")
        .notNull()
        .references(() => reviewAssignments.id),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
      reason: text("reason").notNull(),
      declaredAt: text("declared_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.assignmentId, table.reviewerId] })],
  );
  const reviewEvaluations = sqliteTable(
    "review_evaluations",
    {
      assignmentId: text("assignment_id")
        .notNull()
        .references(() => reviewAssignments.id),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
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
  const reviewOutcomes = sqliteTable(
    "review_outcomes",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      round: integer("round").notNull().default(1),
      completedEvaluationCount: integer("completed_evaluation_count").notNull(),
      averageScore: real("average_score").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.proposalId, table.round] }),
      check("review_outcomes_round", sql`${table.round} > 0`),
    ],
  );
  // The organizer's acceptance decision. `cfp_submissions.status` carries the workflow state the
  // triage board filters on and organizers may rename; this row is the durable record of who
  // decided what and when, and it is what content acceptance is gated on (`ARC-FLOW-001`).
  const reviewDecisions = sqliteTable(
    "review_decisions",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      outcome: text("outcome").notNull(),
      decidedBy: text("decided_by")
        .notNull()
        .references(() => references.usersId),
      decidedAt: text("decided_at").notNull(),
      note: text("note").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.proposalId] }),
      check("review_decisions_outcome", sql`${table.outcome} IN ('accepted', 'declined')`),
      index("review_decisions_event_outcome_idx").on(table.eventId, table.outcome),
    ],
  );
  const reviewEvents = sqliteTable(
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

  return {
    cfpStatusAudit,
    cfpStatuses,
    reviewPlans,
    reviewAssignments,
    reviewAssignmentCaps,
    reviewConflicts,
    reviewEvaluations,
    reviewOutcomes,
    reviewDecisions,
    reviewEvents,
  };
}
