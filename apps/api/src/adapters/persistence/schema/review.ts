import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
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
  /**
   * A named, date-bounded review round with its own scorecard, anonymization policy and pool.
   *
   * Keyed on `(event_id, sequence)` rather than a surrogate id, and that is the whole design of
   * migration `1312`: `sequence` **is** the integer `review_assignments.round`,
   * `review_outcomes.round` and `review_suggestions.round` have carried since `1300`, so rounds
   * became first-class without rebuilding a single table that holds an assignment, an evaluation,
   * a conflict, an outcome or a suggestion's provenance. See that migration for why the surrogate
   * key was the more dangerous shape.
   *
   * The three assignment-time rules — the round exists, it is open, and a `named` pool contains
   * the reviewer — are triggers in `1312` rather than table constraints Drizzle can express, for
   * the same reason `review_suggestions`' conditional CHECK is: adding a foreign key to
   * `review_assignments` would require rebuilding it.
   *
   * @spec PRD-REV-001 PRD-ABS-001
   */
  const reviewRounds = sqliteTable(
    "review_rounds",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sequence: integer("sequence").notNull(),
      name: text("name").notNull(),
      /** NULL is unbounded on that side; a round with no window is open whenever `state` says so. */
      opensAt: text("opens_at"),
      closesAt: text("closes_at"),
      state: text("state").notNull().default("draft"),
      /** Whether reviewers in this round see the author. Read by reviewer-facing projections. */
      anonymized: integer("anonymized").notNull().default(1),
      /** This round's own scorecard; NULL scores against the event's `review_plans` row. */
      criteriaJson: text("criteria_json"),
      poolMode: text("pool_mode").notNull().default("named"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      instructions: text("instructions").notNull().default(""),
      filtersJson: text("filters_json").notNull().default("[]"),
      includedProposalIdsJson: text("included_proposal_ids_json").notNull().default("[]"),
      filterVersion: integer("filter_version").notNull().default(1),
      visibleFieldIdsJson: text("visible_field_ids_json").notNull().default("[]"),
      filesVisible: integer("files_visible", { mode: "boolean" }).notNull().default(false),
      maxEvaluationsPerProposal: integer("max_evaluations_per_proposal").notNull().default(100),
      weeklyReminderWeekday: integer("weekly_reminder_weekday"),
      weeklyReminderHour: integer("weekly_reminder_hour"),
      reminderTimezone: text("reminder_timezone"),
      invitationOccurrence: integer("invitation_occurrence").notNull().default(0),
      aiPersona: text("ai_persona").notNull().default(""),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.sequence] }),
      unique("review_rounds_name_unique").on(table.eventId, table.name),
      check("review_rounds_sequence", sql`${table.sequence} > 0`),
      check("review_rounds_state", sql`${table.state} IN ('draft', 'open', 'closed')`),
      check("review_rounds_anonymized", sql`${table.anonymized} IN (0, 1)`),
      check("review_rounds_pool_mode", sql`${table.poolMode} IN ('event', 'named')`),
      check("review_rounds_filters_json", sql`json_valid(${table.filtersJson})`),
      check(
        "review_rounds_included_proposal_ids_json",
        sql`json_valid(${table.includedProposalIdsJson})`,
      ),
      check("review_rounds_filter_version", sql`${table.filterVersion} > 0`),
      check("review_rounds_visible_field_ids_json", sql`json_valid(${table.visibleFieldIdsJson})`),
      check("review_rounds_files_visible", sql`${table.filesVisible} IN (0, 1)`),
      check(
        "review_rounds_proposal_cap",
        sql`${table.maxEvaluationsPerProposal} BETWEEN 1 AND 100`,
      ),
      check(
        "review_rounds_weekly_reminder_weekday",
        sql`${table.weeklyReminderWeekday} BETWEEN 0 AND 6`,
      ),
      check(
        "review_rounds_weekly_reminder_hour",
        sql`${table.weeklyReminderHour} BETWEEN 0 AND 23`,
      ),
      check("review_rounds_invitation_occurrence", sql`${table.invitationOccurrence} >= 0`),
      check(
        "review_rounds_window",
        sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.opensAt} < ${table.closesAt}`,
      ),
    ],
  );
  /**
   * The reviewer pool of one round.
   *
   * Keyed on the round, which is what makes "membership in one round does not implicitly grant
   * membership in another" a property of the schema rather than a rule in a service: a reviewer in
   * round 1 is simply not among round 2's rows.
   */
  const reviewRoundMembers = sqliteTable(
    "review_round_members",
    {
      eventId: text("event_id").notNull(),
      roundSequence: integer("round_sequence").notNull(),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
      addedAt: text("added_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.roundSequence, table.reviewerId] }),
      // A pool row cannot outlive its round or name one that does not exist. Declared as a
      // composite foreign key rather than two column-level references, because the pair is what
      // identifies a round.
      foreignKey({
        columns: [table.eventId, table.roundSequence],
        foreignColumns: [reviewRounds.eventId, reviewRounds.sequence],
      }),
      index("review_round_members_reviewer_idx").on(table.eventId, table.reviewerId),
    ],
  );
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
      /**
       * Whether this record started from an accepted AI suggestion or was written by hand
       * (`1310`). Defaulted rather than nullable: every row that predates the column was written
       * by hand, so there is no third "unknown" state for a reader to interpret.
       */
      source: text("source").notNull().default("manual"),
      suggestionId: text("suggestion_id").references((): AnySQLiteColumn => reviewSuggestions.id),
    },
    (table) => [
      primaryKey({ columns: [table.assignmentId, table.reviewerId] }),
      check("review_evaluations_state", sql`${table.state} IN ('draft', 'completed')`),
    ],
  );
  /**
   * AI-drafted suggestions, deliberately a sibling of `review_evaluations` rather than columns on
   * it.
   *
   * Nothing that computes `review_outcomes` joins this table, which is what makes "AI never
   * silently changes canonical state" a property of the schema instead of a rule in a service.
   * `state` leaves `offered` only with a named responder — the `CHECK` is in `1310`, which Drizzle
   * cannot express as a table-level constraint referencing two columns conditionally, so it is
   * listed in the migration and not modelled here.
   *
   * @spec PRD-AI-001 PORT-AI
   */
  const reviewSuggestions = sqliteTable(
    "review_suggestions",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      assignmentId: text("assignment_id")
        .notNull()
        .references(() => reviewAssignments.id),
      reviewerId: text("reviewer_id")
        .notNull()
        .references(() => references.usersId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      round: integer("round").notNull().default(1),
      summary: text("summary").notNull(),
      scoresJson: text("scores_json").notNull(),
      state: text("state").notNull().default("offered"),
      provenanceModel: text("provenance_model").notNull(),
      provenancePromptVersion: text("provenance_prompt_version").notNull(),
      provenanceGeneratedAt: text("provenance_generated_at").notNull(),
      provenanceProposalRevision: text("provenance_proposal_revision").notNull(),
      respondedBy: text("responded_by").references(() => references.usersId),
      respondedAt: text("responded_at"),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      check("review_suggestions_round", sql`${table.round} > 0`),
      check("review_suggestions_state", sql`${table.state} IN ('offered', 'accepted', 'rejected')`),
      check(
        "review_suggestions_responder",
        sql`${table.state} = 'offered' OR (${table.respondedBy} IS NOT NULL AND ${table.respondedAt} IS NOT NULL)`,
      ),
      index("review_suggestions_assignment_idx").on(
        table.assignmentId,
        table.reviewerId,
        table.createdAt,
      ),
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
      /** Advances only when the outcome changes; see migration 1311. */
      revision: integer("revision").notNull().default(1),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.proposalId] }),
      check(
        "review_decisions_outcome",
        sql`${table.outcome} IN ('accepted', 'waitlisted', 'revision_requested', 'declined')`,
      ),
      index("review_decisions_event_outcome_idx").on(table.eventId, table.outcome),
    ],
  );
  const reviewDecisionHistory = sqliteTable(
    "review_decision_history",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id")
        .notNull()
        .references(() => references.cfpSubmissionsId),
      revision: integer("revision").notNull(),
      outcome: text("outcome").notNull(),
      decidedBy: text("decided_by")
        .notNull()
        .references(() => references.usersId),
      decidedAt: text("decided_at").notNull(),
      note: text("note").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.proposalId, table.revision] }),
      check(
        "review_decision_history_outcome",
        sql`${table.outcome} IN ('accepted','waitlisted','revision_requested','declined')`,
      ),
      index("review_decision_history_event_time_idx").on(
        table.eventId,
        table.decidedAt,
        table.proposalId,
        table.revision,
      ),
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
    reviewRounds,
    reviewRoundMembers,
    reviewPlans,
    reviewAssignments,
    reviewAssignmentCaps,
    reviewConflicts,
    reviewEvaluations,
    reviewSuggestions,
    reviewOutcomes,
    reviewDecisions,
    reviewDecisionHistory,
    reviewEvents,
  };
}
