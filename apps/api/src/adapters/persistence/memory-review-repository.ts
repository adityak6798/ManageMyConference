import {
  type ReviewRepository,
  ReviewStateConflictError,
} from "../../application/review/review-repository";
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

export class MemoryReviewRepository implements ReviewRepository {
  private plans = new Map<string, EvaluationPlan>();
  private assignments = new Map<string, ReviewAssignment>();
  private conflicts = new Map<string, ReviewConflict>();
  private evaluations = new Map<string, Evaluation>();
  private outcomes = new Map<string, ReviewOutcome>();
  private decisions = new Map<string, ProposalDecision>();
  private suggestions = new Map<string, ReviewSuggestion>();
  readonly events: ReviewCompletedEvent[] = [];

  async getPlan(eventId: string) {
    return this.plans.get(eventId) ?? null;
  }
  async savePlan(plan: EvaluationPlan) {
    const existing = this.plans.get(plan.eventId);
    if (
      [...this.assignments.values()].some(({ eventId }) => eventId === plan.eventId) &&
      existing &&
      JSON.stringify(existing.criteria) !== JSON.stringify(plan.criteria)
    )
      throw new ReviewStateConflictError("Review plan is locked");
    this.plans.set(plan.eventId, plan);
  }
  async createAssignments(assignments: readonly ReviewAssignment[]) {
    if (assignments.some(({ eventId }) => !this.plans.has(eventId)))
      throw new ReviewStateConflictError("Review plan is required");
    for (const assignment of assignments) this.assignments.set(assignment.id, assignment);
    return assignments;
  }
  async createCappedAssignments(
    assignments: readonly ReviewAssignment[],
    caps: ReadonlyMap<string, number>,
  ) {
    const next = [...this.assignments.values(), ...assignments];
    for (const assignment of assignments) {
      const cap = caps.get(assignment.reviewerId);
      if (
        cap === undefined ||
        next.filter(
          (item) =>
            item.eventId === assignment.eventId &&
            item.reviewerId === assignment.reviewerId &&
            (item.round ?? 1) === (assignment.round ?? 1),
        ).length > cap
      )
        throw new ReviewStateConflictError("Reviewer assignment cap changed; retry distribution");
    }
    return this.createAssignments(assignments);
  }
  async listAssignments(eventId: string, reviewerId?: string) {
    return [...this.assignments.values()].filter(
      (assignment) =>
        assignment.eventId === eventId && (!reviewerId || assignment.reviewerId === reviewerId),
    );
  }
  async findAssignment(eventId: string, assignmentId: string) {
    const assignment = this.assignments.get(assignmentId);
    return assignment?.eventId === eventId ? assignment : null;
  }
  async deleteAssignment(eventId: string, assignmentId: string) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.eventId !== eventId) return;
    if (
      [...this.evaluations.values()].some(
        (item) => item.assignmentId === assignmentId && item.state === "completed",
      )
    )
      throw new ReviewStateConflictError("Evaluation is completed");
    // The draft, the conflict and any suggestion describe an assignment that is going away, so
    // they go with it rather than being left pointing at an id nothing resolves. In D1 the
    // suggestion is not merely tidy — it is a foreign key, and leaving it refuses the delete.
    for (const [key, item] of [...this.evaluations])
      if (item.assignmentId === assignmentId) this.evaluations.delete(key);
    for (const [key, item] of [...this.conflicts])
      if (item.assignmentId === assignmentId) this.conflicts.delete(key);
    for (const [key, item] of [...this.suggestions])
      if (item.assignmentId === assignmentId) this.suggestions.delete(key);
    this.assignments.delete(assignmentId);
  }
  async getConflict(assignmentId: string, reviewerId: string) {
    return this.conflicts.get(`${assignmentId}:${reviewerId}`) ?? null;
  }
  async saveConflict(conflict: ReviewConflict) {
    if (
      this.evaluations.get(`${conflict.assignmentId}:${conflict.reviewerId}`)?.state === "completed"
    )
      throw new ReviewStateConflictError("Evaluation is completed");
    this.conflicts.set(`${conflict.assignmentId}:${conflict.reviewerId}`, conflict);
  }
  async getEvaluation(assignmentId: string, reviewerId: string) {
    return this.evaluations.get(`${assignmentId}:${reviewerId}`) ?? null;
  }
  async listEvaluations(eventId: string) {
    const assignmentIds = new Set(
      [...this.assignments.values()]
        .filter((assignment) => assignment.eventId === eventId)
        .map(({ id }) => id),
    );
    return [...this.evaluations.values()].filter(({ assignmentId }) =>
      assignmentIds.has(assignmentId),
    );
  }
  async saveEvaluation(evaluation: Evaluation) {
    const key = `${evaluation.assignmentId}:${evaluation.reviewerId}`;
    if (this.evaluations.get(key)?.state !== "completed") this.evaluations.set(key, evaluation);
  }
  async completeEvaluation(evaluation: Evaluation, event: ReviewCompletedEvent) {
    if (this.conflicts.has(`${evaluation.assignmentId}:${evaluation.reviewerId}`))
      throw new ReviewStateConflictError("Assignment is conflicted");
    const key = `${evaluation.assignmentId}:${evaluation.reviewerId}`;
    if (this.evaluations.get(key)?.state !== "completed") this.evaluations.set(key, evaluation);
    if (!this.events.some((item) => item.assignmentId === event.assignmentId))
      this.events.push(event);
    const assignment = this.assignments.get(event.assignmentId);
    const round = assignment?.round ?? 1;
    const roundAssignmentIds = new Set(
      [...this.assignments.values()]
        .filter(
          (item) =>
            item.eventId === event.eventId &&
            item.proposalId === event.proposalId &&
            (item.round ?? 1) === round,
        )
        .map(({ id }) => id),
    );
    const completed = (await this.listCompletedEvaluations(event.eventId, event.proposalId)).filter(
      (item) => roundAssignmentIds.has(item.assignmentId),
    );
    const plan = this.plans.get(event.eventId);
    const numeric = new Map(
      (plan?.criteria ?? [])
        .filter((criterion) => !criterion.type || criterion.type === "numeric")
        .map((criterion) => [criterion.id, criterion.weight ?? 1]),
    );
    const values = completed.flatMap(({ scores }) =>
      scores.flatMap((item) => {
        const value = item.value ?? item.score;
        const weight = numeric.get(item.criterionId);
        return typeof value === "number" && weight ? [{ value, weight }] : [];
      }),
    );
    this.outcomes.set(`${event.eventId}:${event.proposalId}:${round}`, {
      eventId: event.eventId,
      proposalId: event.proposalId,
      round,
      completedEvaluationCount: completed.length,
      averageScore:
        values.reduce((total, item) => total + item.value * item.weight, 0) /
        values.reduce((total, item) => total + item.weight, 0),
      updatedAt: event.occurredAt,
    });
  }
  async listCompletedEvaluations(eventId: string, proposalId: string) {
    const assignmentIds = new Set(
      [...this.assignments.values()]
        .filter(
          (assignment) => assignment.eventId === eventId && assignment.proposalId === proposalId,
        )
        .map(({ id }) => id),
    );
    return [...this.evaluations.values()].filter(
      (evaluation) =>
        assignmentIds.has(evaluation.assignmentId) && evaluation.state === "completed",
    );
  }
  async listOutcomes(eventId: string) {
    return [...this.outcomes.values()].filter((outcome) => outcome.eventId === eventId);
  }
  async saveDecision(decision: ProposalDecision) {
    this.decisions.set(`${decision.eventId}:${decision.proposalId}`, decision);
  }
  async findDecision(eventId: string, proposalId: string) {
    return this.decisions.get(`${eventId}:${proposalId}`) ?? null;
  }
  async listDecisions(eventId: string) {
    return [...this.decisions.values()].filter((decision) => decision.eventId === eventId);
  }
  async saveSuggestion(suggestion: ReviewSuggestion) {
    this.suggestions.set(suggestion.id, suggestion);
  }
  async listSuggestionsForReviewer(eventId: string, reviewerId: string) {
    return [...this.suggestions.values()]
      .filter(
        (suggestion) => suggestion.eventId === eventId && suggestion.reviewerId === reviewerId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  async findSuggestion(eventId: string, suggestionId: string, reviewerId: string) {
    const suggestion = this.suggestions.get(suggestionId);
    // A suggestion belonging to another event or another reviewer is indistinguishable from one
    // that does not exist, so this cannot be used to read somebody else's draft (`ARC-AUTH-001`).
    return suggestion?.eventId === eventId && suggestion.reviewerId === reviewerId
      ? suggestion
      : null;
  }
  async acceptSuggestion(
    suggestionId: string,
    reviewerId: string,
    respondedAt: string,
    evaluation: Evaluation,
  ) {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion || suggestion.reviewerId !== reviewerId || suggestion.state !== "offered")
      throw new ReviewStateConflictError("Suggestion has already been answered");
    const key = `${evaluation.assignmentId}:${evaluation.reviewerId}`;
    // The same refusal the storage trigger enforces: a completed evaluation is not reopened by
    // accepting a suggestion, and no draft is written over it.
    if (this.evaluations.get(key)?.state === "completed")
      throw new ReviewStateConflictError("Evaluation is completed");
    this.suggestions.set(suggestionId, {
      ...suggestion,
      state: "accepted",
      respondedBy: reviewerId,
      respondedAt,
    });
    this.evaluations.set(key, evaluation);
  }
  async rejectSuggestion(suggestionId: string, reviewerId: string, respondedAt: string) {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion || suggestion.reviewerId !== reviewerId || suggestion.state !== "offered")
      throw new ReviewStateConflictError("Suggestion has already been answered");
    this.suggestions.set(suggestionId, {
      ...suggestion,
      state: "rejected",
      respondedBy: reviewerId,
      respondedAt,
    });
  }
}
