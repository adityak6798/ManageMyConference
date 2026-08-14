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
import type { ReviewRound } from "../../domain/review/round";
import type { ReviewSuggestion } from "../../domain/review/suggestion";

export class MemoryReviewRepository implements ReviewRepository {
  private rounds = new Map<string, ReviewRound>();
  private plans = new Map<string, EvaluationPlan>();
  private assignments = new Map<string, ReviewAssignment>();
  private conflicts = new Map<string, ReviewConflict>();
  private evaluations = new Map<string, Evaluation>();
  private outcomes = new Map<string, ReviewOutcome>();
  private decisions = new Map<string, ProposalDecision>();
  private suggestions = new Map<string, ReviewSuggestion>();
  readonly events: ReviewCompletedEvent[] = [];

  private roundKey = (eventId: string, sequence: number) => `${eventId}:${sequence}`;

  async listRounds(eventId: string) {
    return [...this.rounds.values()]
      .filter((round) => round.eventId === eventId)
      .sort((left, right) => left.sequence - right.sequence);
  }
  async findRound(eventId: string, sequence: number) {
    return this.rounds.get(this.roundKey(eventId, sequence)) ?? null;
  }
  async createRound(round: ReviewRound) {
    const key = this.roundKey(round.eventId, round.sequence);
    // The two UNIQUE constraints `1312` declares, restated so the suites that drive this twin
    // meet the same refusal the deployed database gives.
    if (this.rounds.has(key))
      throw new ReviewStateConflictError("A round with that number or name already exists");
    if (
      [...this.rounds.values()].some(
        (item) => item.eventId === round.eventId && item.name === round.name,
      )
    )
      throw new ReviewStateConflictError("A round with that number or name already exists");
    this.rounds.set(key, { ...round, reviewerIds: [...new Set(round.reviewerIds)].sort() });
  }
  async updateRound(round: Omit<ReviewRound, "reviewerIds" | "createdAt">) {
    const key = this.roundKey(round.eventId, round.sequence);
    const existing = this.rounds.get(key);
    if (!existing) throw new ReviewStateConflictError("Review round not found");
    if (
      existing.state === "closed" &&
      (JSON.stringify(existing.criteria) !== JSON.stringify(round.criteria) ||
        existing.anonymized !== round.anonymized ||
        existing.opensAt !== round.opensAt ||
        existing.closesAt !== round.closesAt ||
        existing.poolMode !== round.poolMode)
    )
      throw new ReviewStateConflictError("A closed round's terms cannot be changed");
    // The round-scoped twin of `review_plan_lock`, restated so a suite driven against this
    // repository meets the refusal the guarded UPDATE gives. Without it an open round's rubric
    // could change under evaluations already completed, and the next completion would recompute
    // the aggregate over all of them under criteria they were never scored against.
    if (
      (JSON.stringify(existing.criteria ?? null) !== JSON.stringify(round.criteria ?? null) ||
        existing.anonymized !== round.anonymized) &&
      [...this.assignments.values()].some(
        (assignment) =>
          assignment.eventId === round.eventId && (assignment.round ?? 1) === round.sequence,
      )
    )
      throw new ReviewStateConflictError(
        "This round already has assignments, so its scorecard and blind-review policy are locked",
      );
    if (
      [...this.rounds.values()].some(
        (item) =>
          item.eventId === round.eventId &&
          item.sequence !== round.sequence &&
          item.name === round.name,
      )
    )
      throw new ReviewStateConflictError("Another round of this event already has that name");
    this.rounds.set(key, { ...existing, ...round });
  }
  async setRoundMembers(
    eventId: string,
    sequence: number,
    reviewerIds: readonly string[],
    _addedAt: string,
  ) {
    const key = this.roundKey(eventId, sequence);
    const existing = this.rounds.get(key);
    if (!existing) throw new ReviewStateConflictError("Review round not found");
    // A closed round's pool is frozen — the specification says so, and until this line only
    // `pool_mode` was actually frozen, so an organizer could add somebody to the historical
    // record of who reviewed a round six weeks after it closed.
    if (existing.state === "closed")
      throw new ReviewStateConflictError("A closed round's pool cannot be changed");
    const keeping = new Set(reviewerIds);
    const removed = existing.reviewerIds.filter((reviewerId) => !keeping.has(reviewerId));
    if (
      removed.some((reviewerId) =>
        [...this.assignments.values()].some(
          (assignment) =>
            assignment.eventId === eventId &&
            (assignment.round ?? 1) === sequence &&
            assignment.reviewerId === reviewerId,
        ),
      )
    )
      throw new ReviewStateConflictError(
        "A reviewer who already holds assignments in this round cannot be removed from its pool",
      );
    this.rounds.set(key, { ...existing, reviewerIds: [...keeping].sort() });
  }
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
    // The three round guards `1312` installs as triggers, restated here so a suite driven against
    // this twin cannot pass a write the deployed database would refuse. The service checks all
    // three first and says why; these are the storage-level backstops, and they answer with the
    // same sentences the D1 adapter translates its triggers into.
    for (const assignment of assignments) {
      const round = this.rounds.get(this.roundKey(assignment.eventId, assignment.round ?? 1));
      if (!round) throw new ReviewStateConflictError("That review round does not exist");
      if (round.state !== "open")
        throw new ReviewStateConflictError("That review round is not open");
      if (round.poolMode === "named" && !round.reviewerIds.includes(assignment.reviewerId))
        throw new ReviewStateConflictError("That reviewer is not in this round's pool");
    }
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
    // The round's own scorecard where it has one, the event plan where it does not — the same
    // `COALESCE(r.criteria_json, p.criteria_json)` the D1 aggregate does, so the two cannot
    // disagree about what a round was judged under.
    const plan = this.plans.get(event.eventId);
    const criteria =
      this.rounds.get(this.roundKey(event.eventId, round))?.criteria ?? plan?.criteria ?? [];
    const numeric = new Map(
      criteria
        .filter((criterion) => !criterion.type || criterion.type === "numeric")
        .map((criterion) => [criterion.id, criterion.weight ?? 1]),
    );
    /*
     * Counted the way the D1 statement counts, which is not the same as "how many completed".
     *
     * That statement is `COUNT(DISTINCT e.assignment_id)` over the rows that survive the join
     * against the round's criteria, so an evaluation whose criterion ids the rubric no longer
     * contains contributes to neither the mean nor the count. Counting `completed.length` here
     * instead made the two disagree the moment a round's rubric could differ from the evaluations
     * stored under it. `updateRound`'s lock now makes that state unreachable through the service;
     * the twin still counts the same way, because a twin that agrees only while a rule holds is a
     * twin that will disagree the day the rule moves.
     */
    const contributing = completed.filter(({ scores }) =>
      scores.some(
        (item) => typeof (item.value ?? item.score) === "number" && numeric.has(item.criterionId),
      ),
    );
    const values = contributing.flatMap(({ scores }) =>
      scores.flatMap((item) => {
        const value = item.value ?? item.score;
        const weight = numeric.get(item.criterionId);
        return typeof value === "number" && weight ? [{ value, weight }] : [];
      }),
    );
    const divisor = values.reduce((total, item) => total + item.weight, 0);
    // No contributing value means no row, which is what the `INSERT … SELECT … GROUP BY` does
    // when its join matches nothing. Writing `0/0` here stored NaN, which serializes to `null`
    // and is then refused by `reviewOutcomeSchema` — a stored value no reader can parse.
    if (!divisor) return;
    this.outcomes.set(`${event.eventId}:${event.proposalId}:${round}`, {
      eventId: event.eventId,
      proposalId: event.proposalId,
      round,
      completedEvaluationCount: contributing.length,
      averageScore: values.reduce((total, item) => total + item.value * item.weight, 0) / divisor,
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
  /** Mirrors the D1 rule: the revision advances only when the outcome changes. */
  async saveDecision(decision: Omit<ProposalDecision, "revision">): Promise<number> {
    const key = `${decision.eventId}:${decision.proposalId}`;
    const existing = this.decisions.get(key);
    const revision = existing
      ? existing.revision + (existing.outcome === decision.outcome ? 0 : 1)
      : 1;
    this.decisions.set(key, { ...decision, revision });
    return revision;
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
