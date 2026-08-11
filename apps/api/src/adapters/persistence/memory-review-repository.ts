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

export class MemoryReviewRepository implements ReviewRepository {
  private plans = new Map<string, EvaluationPlan>();
  private assignments = new Map<string, ReviewAssignment>();
  private conflicts = new Map<string, ReviewConflict>();
  private evaluations = new Map<string, Evaluation>();
  private outcomes = new Map<string, ReviewOutcome>();
  private decisions = new Map<string, ProposalDecision>();
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
    // The draft and the conflict describe an assignment that is going away, so they go with it
    // rather than being left pointing at an id nothing resolves.
    for (const [key, item] of [...this.evaluations])
      if (item.assignmentId === assignmentId) this.evaluations.delete(key);
    for (const [key, item] of [...this.conflicts])
      if (item.assignmentId === assignmentId) this.conflicts.delete(key);
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
    const completed = await this.listCompletedEvaluations(event.eventId, event.proposalId);
    const values = completed.flatMap(({ scores }) => scores.map(({ score }) => score));
    this.outcomes.set(`${event.eventId}:${event.proposalId}`, {
      eventId: event.eventId,
      proposalId: event.proposalId,
      completedEvaluationCount: completed.length,
      averageScore: values.reduce((total, value) => total + value, 0) / values.length,
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
}
