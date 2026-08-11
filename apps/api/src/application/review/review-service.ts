import {
  ProposalStatusConfigurationError,
  type SubmittedProposalInterface,
} from "../cfp/submitted-proposal-interface";
import type { ProposalStatus } from "../cfp/submitted-proposal-interface";
import { type Actor, CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import type {
  Evaluation,
  EvaluationPlan,
  EvaluationScore,
  ReviewAssignment,
  ReviewCompletedEvent,
} from "../../domain/review/review";
import { type ReviewRepository, ReviewStateConflictError } from "./review-repository";
import type { IdentityDirectory } from "../identity/identity-directory";
import type { EventService } from "../events/event-service";

export class ReviewValidationError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("Review data is invalid");
  }
}

export class ReviewConflictError extends Error {}
export class ReviewNotFoundError extends Error {}

export interface ReviewServiceDependencies {
  repository: ReviewRepository;
  proposals: SubmittedProposalInterface;
  identities: Pick<IdentityDirectory, "isReviewerForEvent" | "listReviewersForEvent">;
  events: Pick<EventService, "get">;
  newId: () => string;
  now: () => Date;
}

// @spec PRD-ABS-001 PRD-REV-001
export class ReviewService {
  constructor(private readonly dependencies: ReviewServiceDependencies) {}

  private organizer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:manage");
  }

  private reviewer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:evaluate");
  }

  async organizerWorkspace(actor: Actor | null, eventId: string, status?: ProposalStatus) {
    this.organizer(actor, eventId);
    const [proposals, plan, assignments, outcomes, audit, statuses, reviewers] = await Promise.all([
      this.dependencies.proposals.list(eventId, status),
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.repository.listAssignments(eventId),
      this.dependencies.repository.listOutcomes(eventId),
      this.dependencies.proposals.listAudit(eventId),
      this.dependencies.proposals.listStatuses(eventId),
      this.dependencies.identities.listReviewersForEvent(eventId),
    ]);
    return { proposals, plan, assignments, outcomes, audit, statuses, reviewers };
  }

  async configureStatuses(
    actor: Actor | null,
    eventId: string,
    statuses: readonly { key: string; label: string; sortOrder: number }[],
  ) {
    this.organizer(actor, eventId);
    const keys = new Set(statuses.map(({ key }) => key));
    if (keys.size !== statuses.length)
      throw new ReviewValidationError({ statuses: ["Status keys must be unique"] });
    const proposals = await this.dependencies.proposals.list(eventId);
    if (proposals.some(({ status }) => !keys.has(status)))
      throw new ReviewValidationError({
        statuses: ["Configured statuses must include every status currently in use"],
      });
    try {
      await this.dependencies.proposals.saveStatuses(eventId, statuses);
    } catch (error) {
      if (error instanceof ProposalStatusConfigurationError)
        throw new ReviewValidationError({ statuses: [error.message] });
      throw error;
    }
    return statuses;
  }

  async configurePlan(
    actor: Actor | null,
    eventId: string,
    criteria: EvaluationPlan["criteria"],
  ): Promise<EvaluationPlan> {
    this.organizer(actor, eventId);
    if (!criteria.length)
      throw new ReviewValidationError({ criteria: ["At least one criterion is required"] });
    const ids = new Set(criteria.map(({ id }) => id));
    if (ids.size !== criteria.length)
      throw new ReviewValidationError({ criteria: ["Criterion IDs must be unique"] });
    const [existing, assignments] = await Promise.all([
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.repository.listAssignments(eventId),
    ]);
    if (
      assignments.length &&
      existing &&
      JSON.stringify(existing.criteria) !== JSON.stringify(criteria)
    )
      throw new ReviewValidationError({
        criteria: ["The rubric is locked after reviewer assignments are created"],
      });
    const plan = { eventId, criteria, updatedAt: this.dependencies.now().toISOString() };
    try {
      await this.dependencies.repository.savePlan(plan);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ criteria: [error.message] });
      throw error;
    }
    return plan;
  }

  async assign(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    reviewerId: string,
  ): Promise<readonly ReviewAssignment[]> {
    this.organizer(actor, eventId);
    if (!(await this.dependencies.identities.isReviewerForEvent(reviewerId, eventId)))
      throw new ReviewValidationError({ reviewerId: ["Choose a reviewer assigned to this event"] });
    const uniqueProposalIds = [...new Set(proposalIds)];
    const proposals = await this.dependencies.proposals.findMany(eventId, uniqueProposalIds);
    if (proposals.length !== uniqueProposalIds.length)
      throw new ReviewNotFoundError("Proposal not found");
    const existing = await this.dependencies.repository.listAssignments(eventId);
    const now = this.dependencies.now().toISOString();
    const assignments = uniqueProposalIds
      .filter(
        (proposalId) =>
          !existing.some(
            (assignment) =>
              assignment.proposalId === proposalId && assignment.reviewerId === reviewerId,
          ),
      )
      .map((proposalId) => ({
        id: this.dependencies.newId(),
        eventId,
        proposalId,
        reviewerId,
        createdAt: now,
      }));
    try {
      return await this.dependencies.repository.createAssignments(assignments);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ plan: [error.message] });
      throw error;
    }
  }

  async bulkTransition(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    toStatus: ProposalStatus,
  ) {
    const authorized = this.organizer(actor, eventId);
    try {
      return await this.dependencies.proposals.transitionAtomically({
        eventId,
        proposalIds: [...new Set(proposalIds)],
        toStatus,
        actorId: authorized.id,
        occurredAt: this.dependencies.now().toISOString(),
        auditIds: proposalIds.map(() => this.dependencies.newId()),
      });
    } catch (error) {
      if (error instanceof ProposalStatusConfigurationError)
        throw new ReviewValidationError({ toStatus: [error.message] });
      throw error;
    }
  }

  async reviewerQueue(actor: Actor | null, eventId: string) {
    const authorized = this.reviewer(actor, eventId);
    const [assignments, plan] = await Promise.all([
      this.dependencies.repository.listAssignments(eventId, authorized.id),
      this.dependencies.repository.getPlan(eventId),
    ]);
    return Promise.all(
      assignments.map(async (assignment) => {
        const [proposal, conflict, evaluation] = await Promise.all([
          this.dependencies.proposals.find(eventId, assignment.proposalId),
          this.dependencies.repository.getConflict(assignment.id, authorized.id),
          this.dependencies.repository.getEvaluation(assignment.id, authorized.id),
        ]);
        if (!proposal) throw new ReviewNotFoundError("Assigned proposal not found");
        return { assignment, proposal, plan, conflict, evaluation };
      }),
    );
  }

  async declareConflict(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
    reason: string,
  ) {
    const authorized = this.reviewer(actor, eventId);
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    if (
      (await this.dependencies.repository.getEvaluation(assignment.id, authorized.id))?.state ===
      "completed"
    )
      throw new ReviewValidationError({
        assignment: ["A completed evaluation cannot be marked conflicted"],
      });
    const conflict = {
      assignmentId: assignment.id,
      reviewerId: authorized.id,
      reason,
      declaredAt: this.dependencies.now().toISOString(),
    };
    try {
      await this.dependencies.repository.saveConflict(conflict);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({
          assignment: ["A completed evaluation cannot be marked conflicted"],
        });
      throw error;
    }
    return conflict;
  }

  async saveEvaluation(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
    input: { scores: readonly EvaluationScore[]; notes: string; complete: boolean },
    correlationId: string,
  ): Promise<Evaluation> {
    const authorized = this.reviewer(actor, eventId);
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    if (await this.dependencies.repository.getConflict(assignment.id, authorized.id))
      throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
    const plan = await this.dependencies.repository.getPlan(eventId);
    if (!plan)
      throw new ReviewValidationError({ plan: ["The organizer has not configured a plan"] });
    const scoreMap = new Map(input.scores.map((score) => [score.criterionId, score.score]));
    const invalid = plan.criteria.filter((criterion) => {
      const score = scoreMap.get(criterion.id);
      return score === undefined || score < criterion.minScore || score > criterion.maxScore;
    });
    if (
      invalid.length ||
      scoreMap.size !== plan.criteria.length ||
      input.scores.length !== plan.criteria.length
    )
      throw new ReviewValidationError({
        scores: ["Provide one in-range score for every evaluation criterion"],
      });
    const existingEvaluation = await this.dependencies.repository.getEvaluation(
      assignment.id,
      authorized.id,
    );
    if (existingEvaluation?.state === "completed" && !input.complete)
      throw new ReviewValidationError({
        evaluation: ["A completed evaluation cannot return to draft"],
      });
    const timestamp = this.dependencies.now().toISOString();
    const requestedEvaluation: Evaluation = {
      assignmentId,
      reviewerId: authorized.id,
      scores: plan.criteria.map(({ id }) => ({
        criterionId: id,
        score: scoreMap.get(id) as number,
      })),
      notes: input.notes,
      state: input.complete ? "completed" : "draft",
      updatedAt: timestamp,
      ...(input.complete ? { completedAt: timestamp } : {}),
    };
    const evaluation =
      existingEvaluation?.state === "completed" ? existingEvaluation : requestedEvaluation;
    if (input.complete) {
      const proposal = await this.dependencies.proposals.find(eventId, assignment.proposalId);
      if (!proposal) throw new ReviewNotFoundError("Proposal not found");
      const scopedEvent = await this.dependencies.events.get(authorized, eventId);
      if (!scopedEvent) throw new ReviewNotFoundError("Event not found");
      const event: ReviewCompletedEvent = {
        type: "EVT-REVIEW-COMPLETED",
        version: 1,
        id: this.dependencies.newId(),
        organizationId: scopedEvent.organizationId,
        eventId,
        proposalId: proposal.id,
        assignmentId,
        reviewerId: authorized.id,
        occurredAt: timestamp,
        correlationId,
        causationId: assignmentId,
      };
      try {
        await this.dependencies.repository.completeEvaluation(evaluation, event);
      } catch (error) {
        if (error instanceof ReviewStateConflictError)
          throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
        throw error;
      }
    } else await this.dependencies.repository.saveEvaluation(evaluation);
    const persisted = await this.dependencies.repository.getEvaluation(
      assignment.id,
      authorized.id,
    );
    if (!persisted) throw new Error("Evaluation persistence did not return a saved record");
    return persisted;
  }

  private async ownedAssignment(eventId: string, assignmentId: string, reviewerId: string) {
    const assignment = await this.dependencies.repository.findAssignment(eventId, assignmentId);
    if (!assignment || assignment.reviewerId !== reviewerId)
      throw new CapabilityDeniedError("Assignment access denied");
    return assignment;
  }
}
