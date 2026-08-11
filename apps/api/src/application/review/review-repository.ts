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
  getConflict(assignmentId: string, reviewerId: string): Promise<ReviewConflict | null>;
  saveConflict(conflict: ReviewConflict): Promise<void>;
  getEvaluation(assignmentId: string, reviewerId: string): Promise<Evaluation | null>;
  saveEvaluation(evaluation: Evaluation): Promise<void>;
  completeEvaluation(evaluation: Evaluation, event: ReviewCompletedEvent): Promise<void>;
  listCompletedEvaluations(eventId: string, proposalId: string): Promise<readonly Evaluation[]>;
  listOutcomes(eventId: string): Promise<readonly ReviewOutcome[]>;
  saveDecision(decision: ProposalDecision): Promise<void>;
  findDecision(eventId: string, proposalId: string): Promise<ProposalDecision | null>;
  listDecisions(eventId: string): Promise<readonly ProposalDecision[]>;
}
