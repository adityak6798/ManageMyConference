import type {
  Evaluation,
  EvaluationPlan,
  ProposalDecision,
  ReviewAssignment,
  ReviewCompletedEvent,
  ReviewConflict,
  ReviewOutcome,
} from "../../domain/review/review";

export class ReviewStateConflictError extends Error {}

export interface ReviewRepository {
  getPlan(eventId: string): Promise<EvaluationPlan | null>;
  savePlan(plan: EvaluationPlan): Promise<void>;
  createAssignments(assignments: readonly ReviewAssignment[]): Promise<readonly ReviewAssignment[]>;
  listAssignments(eventId: string, reviewerId?: string): Promise<readonly ReviewAssignment[]>;
  findAssignment(eventId: string, assignmentId: string): Promise<ReviewAssignment | null>;
  /**
   * Remove one assignment and the unfinished work hanging off it — a draft evaluation and a
   * declared conflict, both of which describe an assignment that is going away.
   *
   * A *completed* evaluation is not unfinished work: it is counted in `review_outcomes` and it
   * emitted `EVT-REVIEW-COMPLETED`, so implementations must refuse with `ReviewStateConflictError`
   * rather than silently changing an aggregate somebody has already acted on.
   */
  deleteAssignment(eventId: string, assignmentId: string): Promise<void>;
  getConflict(assignmentId: string, reviewerId: string): Promise<ReviewConflict | null>;
  saveConflict(conflict: ReviewConflict): Promise<void>;
  getEvaluation(assignmentId: string, reviewerId: string): Promise<Evaluation | null>;
  listEvaluations(eventId: string): Promise<readonly Evaluation[]>;
  saveEvaluation(evaluation: Evaluation): Promise<void>;
  completeEvaluation(evaluation: Evaluation, event: ReviewCompletedEvent): Promise<void>;
  listCompletedEvaluations(eventId: string, proposalId: string): Promise<readonly Evaluation[]>;
  listOutcomes(eventId: string): Promise<readonly ReviewOutcome[]>;
  saveDecision(decision: ProposalDecision): Promise<void>;
  findDecision(eventId: string, proposalId: string): Promise<ProposalDecision | null>;
  listDecisions(eventId: string): Promise<readonly ProposalDecision[]>;
}
