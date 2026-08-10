import {
  type ReviewRepository,
  ReviewStateConflictError,
} from "../../application/review/review-repository";
import type {
  Evaluation,
  EvaluationPlan,
  ReviewAssignment,
  ReviewCompletedEvent,
  ReviewConflict,
} from "../../domain/review/review";
interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
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
};
type OutcomeRow = {
  event_id: string;
  proposal_id: string;
  completed_evaluation_count: number;
  average_score: number;
  updated_at: string;
};

const assignment = (row: AssignmentRow): ReviewAssignment => ({
  id: row.id,
  eventId: row.event_id,
  proposalId: row.proposal_id,
  reviewerId: row.reviewer_id,
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
});

// @spec PRD-REV-001
export class D1ReviewRepository implements ReviewRepository {
  constructor(private readonly database: D1ReviewDatabasePort) {}
  private ensure(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
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
    const result = await this.database
      .prepare(
        "INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET criteria_json = excluded.criteria_json, updated_at = excluded.updated_at",
      )
      .bind(plan.eventId, JSON.stringify(plan.criteria), plan.updatedAt)
      .run();
    this.ensure(result, "save review plan");
  }
  async createAssignments(assignments: readonly ReviewAssignment[]) {
    if (!assignments.length) return [];
    const results = await this.database.batch(
      assignments.map((item) =>
        this.database
          .prepare(
            "INSERT OR IGNORE INTO review_assignments (id, event_id, proposal_id, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(item.id, item.eventId, item.proposalId, item.reviewerId, item.createdAt),
      ),
    );
    if (results.some((result) => !result.success))
      throw new Error("D1 failed to create review assignments");
    const persisted = await this.listAssignments(assignments[0]?.eventId as string);
    const requested = new Set(assignments.map((item) => `${item.proposalId}:${item.reviewerId}`));
    return persisted.filter((item) => requested.has(`${item.proposalId}:${item.reviewerId}`));
  }
  async listAssignments(eventId: string, reviewerId?: string) {
    const result = await this.database
      .prepare(
        `SELECT id, event_id, proposal_id, reviewer_id, created_at FROM review_assignments WHERE event_id = ?${reviewerId ? " AND reviewer_id = ?" : ""} ORDER BY created_at`,
      )
      .bind(eventId, ...(reviewerId ? [reviewerId] : []))
      .all<AssignmentRow>();
    this.ensure(result, "list review assignments");
    return (result.results ?? []).map(assignment);
  }
  async findAssignment(eventId: string, assignmentId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, proposal_id, reviewer_id, created_at FROM review_assignments WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, assignmentId)
      .all<AssignmentRow>();
    this.ensure(result, "find review assignment");
    return result.results?.[0] ? assignment(result.results[0]) : null;
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
        "SELECT assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at FROM review_evaluations WHERE assignment_id = ? AND reviewer_id = ? LIMIT 1",
      )
      .bind(assignmentId, reviewerId)
      .all<EvaluationRow>();
    this.ensure(result, "get evaluation");
    return result.results?.[0] ? evaluation(result.results[0]) : null;
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
            "INSERT INTO review_outcomes (event_id, proposal_id, completed_evaluation_count, average_score, updated_at) SELECT ?, ?, COUNT(DISTINCT e.assignment_id), AVG(CAST(json_extract(score.value, '$.score') AS REAL)), ? FROM review_evaluations e JOIN review_assignments a ON a.id = e.assignment_id JOIN json_each(e.scores_json) score WHERE a.event_id = ? AND a.proposal_id = ? AND e.state = 'completed' ON CONFLICT(event_id, proposal_id) DO UPDATE SET completed_evaluation_count = excluded.completed_evaluation_count, average_score = excluded.average_score, updated_at = excluded.updated_at",
          )
          .bind(event.eventId, event.proposalId, event.occurredAt, event.eventId, event.proposalId),
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
        "SELECT e.assignment_id, e.reviewer_id, e.scores_json, e.notes, e.state, e.updated_at, e.completed_at FROM review_evaluations e JOIN review_assignments a ON a.id = e.assignment_id WHERE a.event_id = ? AND a.proposal_id = ? AND e.state = 'completed'",
      )
      .bind(eventId, proposalId)
      .all<EvaluationRow>();
    this.ensure(result, "list completed evaluations");
    return (result.results ?? []).map(evaluation);
  }
  async listOutcomes(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, proposal_id, completed_evaluation_count, average_score, updated_at FROM review_outcomes WHERE event_id = ? ORDER BY proposal_id",
      )
      .bind(eventId)
      .all<OutcomeRow>();
    this.ensure(result, "list review outcomes");
    return (result.results ?? []).map((row) => ({
      eventId: row.event_id,
      proposalId: row.proposal_id,
      completedEvaluationCount: row.completed_evaluation_count,
      averageScore: row.average_score,
      updatedAt: row.updated_at,
    }));
  }
}
