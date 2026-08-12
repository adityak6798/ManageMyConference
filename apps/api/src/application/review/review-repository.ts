import type {
  Evaluation,
  EvaluationPlan,
  ProposalDecision,
  ReviewAssignment,
  ReviewCompletedEvent,
  ReviewConflict,
  ReviewOutcome,
} from "../../domain/review/review";
import type { ReviewSuggestion } from "../../domain/review/suggestion";

export class ReviewStateConflictError extends Error {}

export interface ReviewRepository {
  getPlan(eventId: string): Promise<EvaluationPlan | null>;
  savePlan(plan: EvaluationPlan): Promise<void>;
  createAssignments(assignments: readonly ReviewAssignment[]): Promise<readonly ReviewAssignment[]>;
  createCappedAssignments(
    assignments: readonly ReviewAssignment[],
    caps: ReadonlyMap<string, number>,
  ): Promise<readonly ReviewAssignment[]>;
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

  /**
   * Store a freshly drafted suggestion in the `offered` state.
   *
   * Writing it is the *only* thing that happens on the drafting path — no evaluation, no outcome,
   * no decision. That is what makes the port safe to point at a live model: the worst a bad
   * provider can do is put a bad draft on a screen.
   */
  saveSuggestion(suggestion: ReviewSuggestion): Promise<void>;
  /** Every suggestion this reviewer has been offered in this event, oldest first. */
  listSuggestionsForReviewer(
    eventId: string,
    reviewerId: string,
  ): Promise<readonly ReviewSuggestion[]>;
  findSuggestion(
    eventId: string,
    suggestionId: string,
    reviewerId: string,
  ): Promise<ReviewSuggestion | null>;
  /**
   * Mark a suggestion accepted **and** write the reviewer's draft evaluation, together.
   *
   * One call rather than two because the pair is the human action: a suggestion recorded as
   * accepted with no evaluation behind it would claim a reviewer took a step they did not, and an
   * evaluation citing an `offered` suggestion is a provenance claim storage refuses (`1310`).
   * The evaluation is always a **draft** — completing it is a second, separate reviewer action.
   *
   * Implementations must refuse with `ReviewStateConflictError` when the suggestion is no longer
   * `offered`, so a double submission cannot overwrite scores the reviewer has since edited.
   */
  acceptSuggestion(
    suggestionId: string,
    reviewerId: string,
    respondedAt: string,
    evaluation: Evaluation,
  ): Promise<void>;
  /**
   * Record a rejection. Leaves no canonical trace beyond this row: no evaluation is written and
   * no aggregate moves. The row survives as the audit record of what was offered and declined.
   */
  rejectSuggestion(suggestionId: string, reviewerId: string, respondedAt: string): Promise<void>;
}
