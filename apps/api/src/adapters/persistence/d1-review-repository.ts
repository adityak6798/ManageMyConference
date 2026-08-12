import {
  type ReviewRepository,
  ReviewStateConflictError,
} from "../../application/review/review-repository";
import { changedRows, type D1WriteResult } from "./d1-write-result";
import type {
  DecisionOutcome,
  Evaluation,
  EvaluationPlan,
  ProposalDecision,
  ReviewAssignment,
  ReviewCompletedEvent,
  ReviewConflict,
} from "../../domain/review/review";
import type {
  EvaluationSource,
  ReviewSuggestion,
  SuggestionState,
} from "../../domain/review/suggestion";

interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
  /**
   * What the driver says the statement touched.
   *
   * Optional here because most reads never look at it; a *write* whose correctness depends on it
   * goes through `changedRows`, which refuses a missing count rather than guessing. That contract
   * is the repository's rather than this adapter's — see `d1-write-result.ts` (#133).
   */
  meta?: { changes?: number };
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}
export interface D1ReviewDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

type PlanRow = { event_id: string; criteria_json: string; updated_at: string };
type AssignmentRow = {
  id: string;
  event_id: string;
  proposal_id: string;
  reviewer_id: string;
  round: number;
  created_at: string;
};
type ConflictRow = {
  assignment_id: string;
  reviewer_id: string;
  reason: string;
  declared_at: string;
};
type EvaluationRow = {
  assignment_id: string;
  reviewer_id: string;
  scores_json: string;
  notes: string;
  state: "draft" | "completed";
  updated_at: string;
  completed_at: string | null;
  source: EvaluationSource;
  suggestion_id: string | null;
};

type SuggestionRow = {
  id: string;
  event_id: string;
  assignment_id: string;
  reviewer_id: string;
  proposal_id: string;
  round: number;
  summary: string;
  scores_json: string;
  state: SuggestionState;
  provenance_model: string;
  provenance_prompt_version: string;
  provenance_generated_at: string;
  provenance_proposal_revision: string;
  responded_by: string | null;
  responded_at: string | null;
  created_at: string;
};

/** Every column, named once, so the four reads below cannot drift apart on provenance. */
const SUGGESTION_COLUMNS =
  "id, event_id, assignment_id, reviewer_id, proposal_id, round, summary, scores_json, state, provenance_model, provenance_prompt_version, provenance_generated_at, provenance_proposal_revision, responded_by, responded_at, created_at";

const suggestion = (row: SuggestionRow): ReviewSuggestion => ({
  id: row.id,
  eventId: row.event_id,
  assignmentId: row.assignment_id,
  reviewerId: row.reviewer_id,
  proposalId: row.proposal_id,
  round: row.round,
  summary: row.summary,
  scores: JSON.parse(row.scores_json),
  state: row.state,
  provenance: {
    model: row.provenance_model,
    promptVersion: row.provenance_prompt_version,
    generatedAt: row.provenance_generated_at,
    proposalRevision: row.provenance_proposal_revision,
  },
  respondedBy: row.responded_by,
  respondedAt: row.responded_at,
  createdAt: row.created_at,
});
type OutcomeRow = {
  event_id: string;
  proposal_id: string;
  round: number;
  completed_evaluation_count: number;
  average_score: number;
  updated_at: string;
};

type DecisionRow = {
  event_id: string;
  proposal_id: string;
  outcome: DecisionOutcome;
  decided_by: string;
  decided_at: string;
  note: string;
};

const decision = (row: DecisionRow): ProposalDecision => ({
  eventId: row.event_id,
  proposalId: row.proposal_id,
  outcome: row.outcome,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  note: row.note,
});

const assignment = (row: AssignmentRow): ReviewAssignment => ({
  id: row.id,
  eventId: row.event_id,
  proposalId: row.proposal_id,
  reviewerId: row.reviewer_id,
  round: row.round,
  createdAt: row.created_at,
});
const evaluation = (row: EvaluationRow): Evaluation => ({
  assignmentId: row.assignment_id,
  reviewerId: row.reviewer_id,
  scores: JSON.parse(row.scores_json),
  notes: row.notes,
  state: row.state,
  updatedAt: row.updated_at,
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  source: row.source,
  suggestionId: row.suggestion_id,
});

/** The evaluation projection, named once so the four reads cannot disagree about provenance. */
const EVALUATION_COLUMNS =
  "assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source, suggestion_id";

// @spec PRD-REV-001
export class D1ReviewRepository implements ReviewRepository {
  constructor(private readonly database: D1ReviewDatabasePort) {}
  private ensure(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
  }
  /**
   * How many rows a write touched, through the repository-wide contract.
   *
   * A driver that cannot report a count is a **failure**, never a silent 0 or 1 — `changedRows`
   * enforces that for every adapter (#133), and this wrapper only adds the statement-level
   * success check that has to happen first. The stakes here are specific: reading a missing count
   * as zero would report a suggestion the reviewer really did accept as "already answered", and
   * reading it as one would report an acceptance that never landed as done. The second is the
   * dangerous direction, because this feature rests on a reviewer's acceptance being a real,
   * recorded act.
   */
  private changed(result: D1Result<unknown>, operation: string): number {
    this.ensure(result, operation);
    return changedRows(result as D1WriteResult, operation);
  }
  async getPlan(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, criteria_json, updated_at FROM review_plans WHERE event_id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<PlanRow>();
    this.ensure(result, "get review plan");
    const row = result.results?.[0];
    return row
      ? {
          eventId: row.event_id,
          criteria: JSON.parse(row.criteria_json),
          updatedAt: row.updated_at,
        }
      : null;
  }
  async savePlan(plan: EvaluationPlan) {
    let result: D1Result<unknown>;
    try {
      result = await this.database
        .prepare(
          "INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET criteria_json = excluded.criteria_json, updated_at = excluded.updated_at",
        )
        .bind(plan.eventId, JSON.stringify(plan.criteria), plan.updatedAt)
        .run();
    } catch (error) {
      if (String(error).includes("REVIEW_PLAN_LOCKED"))
        throw new ReviewStateConflictError("Review plan is locked");
      throw error;
    }
    this.ensure(result, "save review plan");
  }
  async createAssignments(assignments: readonly ReviewAssignment[]) {
    if (!assignments.length) return [];
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch(
        assignments.map((item) =>
          this.database
            .prepare(
              "INSERT OR IGNORE INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(
              item.id,
              item.eventId,
              item.proposalId,
              item.reviewerId,
              item.round ?? 1,
              item.createdAt,
            ),
        ),
      );
    } catch (error) {
      if (String(error).includes("REVIEW_PLAN_REQUIRED"))
        throw new ReviewStateConflictError("Review plan is required");
      throw error;
    }
    if (results.some((result) => !result.success))
      throw new Error("D1 failed to create review assignments");
    const persisted = await this.listAssignments(assignments[0]?.eventId as string);
    const requested = new Set(
      assignments.map((item) => `${item.proposalId}:${item.reviewerId}:${item.round ?? 1}`),
    );
    return persisted.filter((item) =>
      requested.has(`${item.proposalId}:${item.reviewerId}:${item.round}`),
    );
  }
  async createCappedAssignments(
    assignments: readonly ReviewAssignment[],
    caps: ReadonlyMap<string, number>,
  ) {
    if (!assignments.length) return [];
    const first = assignments[0] as ReviewAssignment;
    const reviewers = [...new Set(assignments.map(({ reviewerId }) => reviewerId))];
    try {
      const results = await this.database.batch([
        ...reviewers.map((reviewerId) =>
          this.database
            .prepare(
              "INSERT INTO review_assignment_caps (event_id, reviewer_id, round, assignment_cap) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, reviewer_id, round) DO UPDATE SET assignment_cap = excluded.assignment_cap",
            )
            .bind(first.eventId, reviewerId, first.round ?? 1, caps.get(reviewerId)),
        ),
        ...assignments.map((item) =>
          this.database
            .prepare(
              "INSERT OR IGNORE INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(
              item.id,
              item.eventId,
              item.proposalId,
              item.reviewerId,
              item.round ?? 1,
              item.createdAt,
            ),
        ),
        ...reviewers.map((reviewerId) =>
          this.database
            .prepare(
              "DELETE FROM review_assignment_caps WHERE event_id = ? AND reviewer_id = ? AND round = ?",
            )
            .bind(first.eventId, reviewerId, first.round ?? 1),
        ),
      ]);
      if (results.some((result) => !result.success))
        throw new ReviewStateConflictError("Reviewer assignment cap changed; retry distribution");
    } catch (error) {
      if (String(error).includes("REVIEW_ASSIGNMENT_CAP"))
        throw new ReviewStateConflictError("Reviewer assignment cap changed; retry distribution");
      if (String(error).includes("REVIEW_PLAN_REQUIRED"))
        throw new ReviewStateConflictError("Review plan is required");
      throw error;
    }
    const persisted = await this.listAssignments(first.eventId);
    const requested = new Set(
      assignments.map((item) => `${item.proposalId}:${item.reviewerId}:${item.round ?? 1}`),
    );
    return persisted.filter((item) =>
      requested.has(`${item.proposalId}:${item.reviewerId}:${item.round}`),
    );
  }
  async listAssignments(eventId: string, reviewerId?: string) {
    const result = await this.database
      .prepare(
        `SELECT id, event_id, proposal_id, reviewer_id, round, created_at FROM review_assignments WHERE event_id = ?${reviewerId ? " AND reviewer_id = ?" : ""} ORDER BY round, created_at`,
      )
      .bind(eventId, ...(reviewerId ? [reviewerId] : []))
      .all<AssignmentRow>();
    this.ensure(result, "list review assignments");
    return (result.results ?? []).map(assignment);
  }
  async findAssignment(eventId: string, assignmentId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, proposal_id, reviewer_id, round, created_at FROM review_assignments WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, assignmentId)
      .all<AssignmentRow>();
    this.ensure(result, "find review assignment");
    return result.results?.[0] ? assignment(result.results[0]) : null;
  }
  /**
   * Remove an assignment together with the unfinished work hanging off it.
   *
   * Guarded rather than checked-then-run: both deletes that could orphan a score carry a
   * `NOT EXISTS … state = 'completed'` predicate, so an evaluation completed between the
   * service's read and this write leaves every row in place instead of half-removing an
   * assignment whose score is already counted. The assignment row is therefore still there
   * afterwards, and that is what this reports as the conflict — no row count from the driver is
   * needed to tell the two outcomes apart.
   */
  async deleteAssignment(eventId: string, assignmentId: string) {
    // Every statement is scoped to an assignment of *this* event, so an id belonging to another
    // event cannot reach that event's conflict or draft rows.
    const owned =
      "assignment_id IN (SELECT id FROM review_assignments WHERE id = ? AND event_id = ?)";
    const unscored =
      "NOT EXISTS (SELECT 1 FROM review_evaluations WHERE assignment_id = ? AND state = 'completed')";
    const results = await this.database.batch([
      this.database
        .prepare(`DELETE FROM review_conflicts WHERE ${owned} AND ${unscored}`)
        .bind(assignmentId, eventId, assignmentId),
      this.database
        .prepare(`DELETE FROM review_evaluations WHERE ${owned} AND state != 'completed'`)
        .bind(assignmentId, eventId),
      // Last, so the rows referencing it by foreign key are already gone.
      this.database
        .prepare(`DELETE FROM review_assignments WHERE id = ? AND event_id = ? AND ${unscored}`)
        .bind(assignmentId, eventId, assignmentId),
    ]);
    for (const result of results) this.ensure(result, "remove review assignment");
    if (await this.findAssignment(eventId, assignmentId))
      throw new ReviewStateConflictError("Evaluation is completed");
  }
  async getConflict(assignmentId: string, reviewerId: string) {
    const result = await this.database
      .prepare(
        "SELECT assignment_id, reviewer_id, reason, declared_at FROM review_conflicts WHERE assignment_id = ? AND reviewer_id = ? LIMIT 1",
      )
      .bind(assignmentId, reviewerId)
      .all<ConflictRow>();
    this.ensure(result, "get review conflict");
    const row = result.results?.[0];
    return row
      ? {
          assignmentId: row.assignment_id,
          reviewerId: row.reviewer_id,
          reason: row.reason,
          declaredAt: row.declared_at,
        }
      : null;
  }
  async saveConflict(conflict: ReviewConflict) {
    let result: D1Result<unknown>;
    try {
      result = await this.database
        .prepare(
          "INSERT INTO review_conflicts (assignment_id, reviewer_id, reason, declared_at) VALUES (?, ?, ?, ?) ON CONFLICT(assignment_id, reviewer_id) DO UPDATE SET reason = excluded.reason, declared_at = excluded.declared_at",
        )
        .bind(conflict.assignmentId, conflict.reviewerId, conflict.reason, conflict.declaredAt)
        .run();
    } catch (error) {
      if (String(error).includes("REVIEW_COMPLETED"))
        throw new ReviewStateConflictError("Evaluation is completed");
      throw error;
    }
    if (!result.success && result.error?.includes("REVIEW_COMPLETED"))
      throw new ReviewStateConflictError("Evaluation is completed");
    this.ensure(result, "save review conflict");
  }
  async getEvaluation(assignmentId: string, reviewerId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${EVALUATION_COLUMNS} FROM review_evaluations WHERE assignment_id = ? AND reviewer_id = ? LIMIT 1`,
      )
      .bind(assignmentId, reviewerId)
      .all<EvaluationRow>();
    this.ensure(result, "get evaluation");
    return result.results?.[0] ? evaluation(result.results[0]) : null;
  }
  async listEvaluations(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT evaluation.assignment_id, evaluation.reviewer_id, evaluation.scores_json, evaluation.notes, evaluation.state, evaluation.updated_at, evaluation.completed_at, evaluation.source, evaluation.suggestion_id FROM review_evaluations evaluation INNER JOIN review_assignments assignment ON assignment.id = evaluation.assignment_id WHERE assignment.event_id = ? ORDER BY assignment.round, evaluation.updated_at",
      )
      .bind(eventId)
      .all<EvaluationRow>();
    this.ensure(result, "list review evaluations");
    return (result.results ?? []).map(evaluation);
  }
  async saveEvaluation(item: Evaluation) {
    const result = await this.database
      .prepare(
        "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(assignment_id, reviewer_id) DO UPDATE SET scores_json = excluded.scores_json, notes = excluded.notes, state = excluded.state, updated_at = excluded.updated_at, completed_at = excluded.completed_at WHERE review_evaluations.state != 'completed'",
      )
      .bind(
        item.assignmentId,
        item.reviewerId,
        JSON.stringify(item.scores),
        item.notes,
        item.state,
        item.updatedAt,
        item.completedAt ?? null,
      )
      .run();
    this.ensure(result, "save evaluation");
  }
  async completeEvaluation(item: Evaluation, event: ReviewCompletedEvent) {
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch([
        this.database
          .prepare(
            "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?) ON CONFLICT(assignment_id, reviewer_id) DO UPDATE SET scores_json = excluded.scores_json, notes = excluded.notes, state = 'completed', updated_at = excluded.updated_at, completed_at = excluded.completed_at WHERE review_evaluations.state != 'completed'",
          )
          .bind(
            item.assignmentId,
            item.reviewerId,
            JSON.stringify(item.scores),
            item.notes,
            item.updatedAt,
            item.completedAt,
          ),
        this.database
          .prepare(
            "INSERT OR IGNORE INTO review_events (id, event_type, version, organization_id, event_id, proposal_id, assignment_id, reviewer_id, occurred_at, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            event.id,
            event.type,
            event.version,
            event.organizationId,
            event.eventId,
            event.proposalId,
            event.assignmentId,
            event.reviewerId,
            event.occurredAt,
            event.correlationId,
            event.causationId,
          ),
        this.database
          .prepare(
            "INSERT INTO review_outcomes (event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at) SELECT ?, ?, target.round, COUNT(DISTINCT e.assignment_id), SUM(COALESCE(CAST(json_extract(score.value, '$.value') AS REAL), CAST(json_extract(score.value, '$.score') AS REAL)) * COALESCE(CAST(json_extract(criterion.value, '$.weight') AS REAL), 1)) / SUM(COALESCE(CAST(json_extract(criterion.value, '$.weight') AS REAL), 1)), ? FROM review_assignments target JOIN review_assignments a ON a.event_id = target.event_id AND a.proposal_id = target.proposal_id AND a.round = target.round JOIN review_evaluations e ON e.assignment_id = a.id AND e.state = 'completed' JOIN json_each(e.scores_json) score JOIN review_plans p ON p.event_id = a.event_id JOIN json_each(p.criteria_json) criterion ON json_extract(criterion.value, '$.id') = json_extract(score.value, '$.criterionId') WHERE target.id = ? AND (COALESCE(json_extract(criterion.value, '$.type'), 'numeric') = 'numeric') GROUP BY target.round ON CONFLICT(event_id, proposal_id, round) DO UPDATE SET completed_evaluation_count = excluded.completed_evaluation_count, average_score = excluded.average_score, updated_at = excluded.updated_at",
          )
          .bind(event.eventId, event.proposalId, event.occurredAt, event.assignmentId),
      ]);
    } catch (error) {
      if (String(error).includes("REVIEW_CONFLICT"))
        throw new ReviewStateConflictError("Assignment is conflicted");
      throw error;
    }
    if (results.some((result) => result.error?.includes("REVIEW_CONFLICT")))
      throw new ReviewStateConflictError("Assignment is conflicted");
    if (results.some((result) => !result.success))
      throw new Error("D1 failed to complete evaluation atomically");
  }
  async listCompletedEvaluations(eventId: string, proposalId: string) {
    const result = await this.database
      .prepare(
        "SELECT e.assignment_id, e.reviewer_id, e.scores_json, e.notes, e.state, e.updated_at, e.completed_at, e.source, e.suggestion_id FROM review_evaluations e JOIN review_assignments a ON a.id = e.assignment_id WHERE a.event_id = ? AND a.proposal_id = ? AND e.state = 'completed'",
      )
      .bind(eventId, proposalId)
      .all<EvaluationRow>();
    this.ensure(result, "list completed evaluations");
    return (result.results ?? []).map(evaluation);
  }
  async saveDecision(item: ProposalDecision) {
    const result = await this.database
      .prepare(
        "INSERT INTO review_decisions (event_id, proposal_id, outcome, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, proposal_id) DO UPDATE SET outcome = excluded.outcome, decided_by = excluded.decided_by, decided_at = excluded.decided_at, note = excluded.note",
      )
      .bind(item.eventId, item.proposalId, item.outcome, item.decidedBy, item.decidedAt, item.note)
      .run();
    this.ensure(result, "save review decision");
  }
  async findDecision(eventId: string, proposalId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, proposal_id, outcome, decided_by, decided_at, note FROM review_decisions WHERE event_id = ? AND proposal_id = ? LIMIT 1",
      )
      .bind(eventId, proposalId)
      .all<DecisionRow>();
    this.ensure(result, "find review decision");
    return result.results?.[0] ? decision(result.results[0]) : null;
  }
  async listDecisions(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, proposal_id, outcome, decided_by, decided_at, note FROM review_decisions WHERE event_id = ? ORDER BY proposal_id",
      )
      .bind(eventId)
      .all<DecisionRow>();
    this.ensure(result, "list review decisions");
    return (result.results ?? []).map(decision);
  }
  async saveSuggestion(item: ReviewSuggestion) {
    const result = await this.database
      .prepare(
        "INSERT INTO review_suggestions (id, event_id, assignment_id, reviewer_id, proposal_id, round, summary, scores_json, state, provenance_model, provenance_prompt_version, provenance_generated_at, provenance_proposal_revision, responded_by, responded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?, NULL, NULL, ?)",
      )
      .bind(
        item.id,
        item.eventId,
        item.assignmentId,
        item.reviewerId,
        item.proposalId,
        item.round,
        item.summary,
        JSON.stringify(item.scores),
        item.provenance.model,
        item.provenance.promptVersion,
        item.provenance.generatedAt,
        item.provenance.proposalRevision,
        item.createdAt,
      )
      .run();
    this.ensure(result, "save review suggestion");
  }
  async listSuggestionsForReviewer(eventId: string, reviewerId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${SUGGESTION_COLUMNS} FROM review_suggestions WHERE event_id = ? AND reviewer_id = ? ORDER BY created_at`,
      )
      .bind(eventId, reviewerId)
      .all<SuggestionRow>();
    this.ensure(result, "list review suggestions");
    return (result.results ?? []).map(suggestion);
  }
  async findSuggestion(eventId: string, suggestionId: string, reviewerId: string) {
    // Scoped to the event *and* the reviewer, so a suggestion belonging to somebody else is
    // indistinguishable from one that does not exist (`ARC-AUTH-001`).
    const result = await this.database
      .prepare(
        `SELECT ${SUGGESTION_COLUMNS} FROM review_suggestions WHERE id = ? AND event_id = ? AND reviewer_id = ? LIMIT 1`,
      )
      .bind(suggestionId, eventId, reviewerId)
      .all<SuggestionRow>();
    this.ensure(result, "find review suggestion");
    return result.results?.[0] ? suggestion(result.results[0]) : null;
  }
  /**
   * Accept a suggestion and write the reviewer's draft, in one batch and in that order.
   *
   * The evaluation insert is conditioned on the suggestion row this batch's *first* statement
   * just wrote — matched on `responded_at`, not merely on `state = 'accepted'`. That is what makes
   * a second accept a no-op rather than a silent overwrite of scores the reviewer has since
   * edited: the second call's `UPDATE` matches nothing (the state is no longer `offered`), so the
   * `EXISTS` names a timestamp that is not there and the evaluation is left alone.
   *
   * Both statements also refuse when the reviewer has already completed this evaluation. The
   * service checks that first; this is the guard for a completion that lands between the two.
   *
   * The outcome is decided by the row counts, and a driver that will not report one is a failure
   * rather than an assumed 0 or 1 — see `changed`.
   */
  async acceptSuggestion(
    suggestionId: string,
    reviewerId: string,
    respondedAt: string,
    item: Evaluation,
  ) {
    const notCompleted =
      "NOT EXISTS (SELECT 1 FROM review_evaluations WHERE assignment_id = ? AND reviewer_id = ? AND state = 'completed')";
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE review_suggestions SET state = 'accepted', responded_by = ?, responded_at = ? WHERE id = ? AND reviewer_id = ? AND state = 'offered' AND ${notCompleted}`,
        )
        .bind(reviewerId, respondedAt, suggestionId, reviewerId, item.assignmentId, reviewerId),
      this.database
        .prepare(
          `INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source, suggestion_id) SELECT ?, ?, ?, ?, 'draft', ?, NULL, 'suggested', ? WHERE EXISTS (SELECT 1 FROM review_suggestions WHERE id = ? AND reviewer_id = ? AND state = 'accepted' AND responded_at = ?) ON CONFLICT(assignment_id, reviewer_id) DO UPDATE SET scores_json = excluded.scores_json, notes = excluded.notes, state = 'draft', updated_at = excluded.updated_at, source = 'suggested', suggestion_id = excluded.suggestion_id WHERE review_evaluations.state != 'completed'`,
        )
        .bind(
          item.assignmentId,
          reviewerId,
          JSON.stringify(item.scores),
          item.notes,
          item.updatedAt,
          suggestionId,
          suggestionId,
          reviewerId,
          respondedAt,
        ),
    ]);
    const [answered, drafted] = results.map((result, index) =>
      this.changed(result, index === 0 ? "accept review suggestion" : "write the accepted draft"),
    );
    // Neither statement matching is the ordinary race: somebody answered this suggestion first,
    // or completed the evaluation between the service's read and this write.
    if (answered === 0) throw new ReviewStateConflictError("Suggestion has already been answered");
    // The suggestion moved but the draft did not, which the guards above are meant to make
    // impossible. Reported rather than swallowed, because the pair is the whole point: a
    // suggestion recorded as accepted with no draft behind it claims the reviewer did something
    // they did not.
    if (drafted === 0)
      throw new Error("D1 accepted a review suggestion without writing the reviewer's draft");
  }
  async rejectSuggestion(suggestionId: string, reviewerId: string, respondedAt: string) {
    const result = await this.database
      .prepare(
        "UPDATE review_suggestions SET state = 'rejected', responded_by = ?, responded_at = ? WHERE id = ? AND reviewer_id = ? AND state = 'offered'",
      )
      .bind(reviewerId, respondedAt, suggestionId, reviewerId)
      .run();
    if (this.changed(result, "reject review suggestion") === 0)
      throw new ReviewStateConflictError("Suggestion has already been answered");
  }
  async listOutcomes(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at FROM review_outcomes WHERE event_id = ? ORDER BY round DESC, average_score DESC, proposal_id",
      )
      .bind(eventId)
      .all<OutcomeRow>();
    this.ensure(result, "list review outcomes");
    return (result.results ?? []).map((row) => ({
      eventId: row.event_id,
      proposalId: row.proposal_id,
      round: row.round,
      completedEvaluationCount: row.completed_evaluation_count,
      averageScore: row.average_score,
      updatedAt: row.updated_at,
    }));
  }
}
