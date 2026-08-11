import {
  MASKED_SUBMITTER_NAME,
  ProposalStatusConfigurationError,
  type SubmittedProposal,
  type SubmittedProposalInterface,
} from "../cfp/submitted-proposal-interface";
import type { ProposalStatus, ProposalStatusDefinition } from "../cfp/submitted-proposal-interface";
import { type Actor, CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import {
  ACCEPTED_PROPOSAL_STATUS,
  type DecisionOutcome,
  type Evaluation,
  type EvaluationPlan,
  type EvaluationScore,
  type ProposalDecision,
  RESERVED_PROPOSAL_STATUSES,
  type ReviewAssignment,
  type ReviewCompletedEvent,
} from "../../domain/review/review";
import { type ReviewRepository, ReviewStateConflictError } from "./review-repository";
import {
  type AcceptedProposal,
  type AcceptedProposalQuery,
  ProposalNotAcceptedError,
  ProposalNotFoundError,
  ProposalSubmitterUnavailableError,
} from "./public";
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

/**
 * Field ids and labels that name the session format. Formats are organizer vocabulary rather than
 * a CFP field type, so an unmatched proposal accepts the neutral default and the organizer edits
 * the session afterwards.
 */
const FORMAT_FIELD_IDS = ["format", "session_format", "session_type", "type"];
const FORMAT_LABEL = /\b(format|session type)\b/i;
const DEFAULT_SESSION_FORMAT = "Session";
const formatOf = (proposal: SubmittedProposal) =>
  proposal.answers.find(
    ({ fieldId, label }) =>
      FORMAT_FIELD_IDS.includes(fieldId.toLowerCase()) || FORMAT_LABEL.test(label),
  )?.value || DEFAULT_SESSION_FORMAT;

/**
 * Blind review is a projection concern, not a storage one: the same stored proposal is shown with
 * its submitter to organizers and without to reviewers. This is the mask.
 */
const withoutSubmitter = (proposal: SubmittedProposal): SubmittedProposal => ({
  ...proposal,
  submitterName: MASKED_SUBMITTER_NAME,
  submitter: null,
});

/**
 * The configured statuses plus any reserved decision status missing from them.
 *
 * Migration 0021 backfilled every event that existed then, but the CFP's own insert trigger
 * only seeds `submitted` for an event created afterwards. Without this an organizer's first
 * acceptance on a new event would hit "choose a configured proposal status".
 */
const withReservedStatuses = (
  statuses: readonly ProposalStatusDefinition[],
): readonly ProposalStatusDefinition[] => {
  const keys = new Set(statuses.map(({ key }) => key));
  return [...statuses, ...RESERVED_PROPOSAL_STATUSES.filter(({ key }) => !keys.has(key))];
};

// @spec PRD-ABS-001 PRD-REV-001
export class ReviewService implements AcceptedProposalQuery {
  constructor(private readonly dependencies: ReviewServiceDependencies) {}

  private organizer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:manage");
  }

  private reviewer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:evaluate");
  }

  async organizerWorkspace(actor: Actor | null, eventId: string, status?: ProposalStatus) {
    this.organizer(actor, eventId);
    const [proposals, plan, assignments, outcomes, audit, statuses, reviewers, decisions] =
      await Promise.all([
        this.dependencies.proposals.list(eventId, status),
        this.dependencies.repository.getPlan(eventId),
        this.dependencies.repository.listAssignments(eventId),
        this.dependencies.repository.listOutcomes(eventId),
        this.dependencies.proposals.listAudit(eventId),
        this.dependencies.proposals.listStatuses(eventId),
        this.dependencies.identities.listReviewersForEvent(eventId),
        this.dependencies.repository.listDecisions(eventId),
      ]);
    return {
      proposals,
      plan,
      assignments,
      outcomes,
      audit,
      statuses: withReservedStatuses(statuses),
      reviewers,
      decisions,
    };
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
    const missingReserved = RESERVED_PROPOSAL_STATUSES.filter(({ key }) => !keys.has(key));
    // Acceptance is not a label an organizer can delete out from under the content domain.
    if (missingReserved.length)
      throw new ReviewValidationError({
        statuses: [
          `Keep the reserved decision statuses: ${missingReserved.map(({ key }) => key).join(", ")}`,
        ],
      });
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

  /**
   * Record an accept/decline decision on proposals.
   *
   * The status transition runs first through the CFP interface, which audits it atomically and
   * refuses an unconfigured status; the decision record is written second. Ordered that way a
   * partial failure leaves a proposal that looks accepted on the board but carries no decision,
   * so `acceptedProposal` — and therefore content acceptance — still refuses it. The reverse
   * order would authorize content off a half-written decision. Re-deciding overwrites, so a
   * retry heals the gap.
   */
  async decide(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    outcome: DecisionOutcome,
    note = "",
  ): Promise<{ proposals: readonly SubmittedProposal[]; decisions: readonly ProposalDecision[] }> {
    const authorized = this.organizer(actor, eventId);
    const uniqueProposalIds = [...new Set(proposalIds)];
    const found = await this.dependencies.proposals.findMany(eventId, uniqueProposalIds);
    if (found.length !== uniqueProposalIds.length)
      throw new ReviewNotFoundError("Proposal not found");
    const configured = await this.dependencies.proposals.listStatuses(eventId);
    // Self-healing: an event whose status set predates or postdates the reserved keys gets them
    // before the transition rather than a "choose a configured proposal status" failure.
    if (!configured.some(({ key }) => key === outcome))
      await this.dependencies.proposals.saveStatuses(eventId, withReservedStatuses(configured));
    const decidedAt = this.dependencies.now().toISOString();
    const proposals = await this.dependencies.proposals.transitionAtomically({
      eventId,
      proposalIds: uniqueProposalIds,
      toStatus: outcome,
      actorId: authorized.id,
      occurredAt: decidedAt,
      auditIds: uniqueProposalIds.map(() => this.dependencies.newId()),
    });
    const decisions = uniqueProposalIds.map((proposalId) => ({
      eventId,
      proposalId,
      outcome,
      decidedBy: authorized.id,
      decidedAt,
      note,
    }));
    for (const decision of decisions) await this.dependencies.repository.saveDecision(decision);
    return { proposals, decisions };
  }

  /**
   * The review domain's answer to "may this proposal become program content?".
   *
   * `AcceptedProposalQuery`; the content domain calls exactly this and never touches
   * `cfp_submissions`.
   */
  async acceptedProposal(eventId: string, proposalId: string): Promise<AcceptedProposal> {
    const proposal = await this.dependencies.proposals.find(eventId, proposalId);
    // A proposal belonging to another event is indistinguishable from one that does not exist,
    // so acceptance cannot be used to probe another event's ids (`ARC-AUTH-001`).
    if (!proposal) throw new ProposalNotFoundError("Proposal not found for this event");
    const decision = await this.dependencies.repository.findDecision(eventId, proposalId);
    if (decision?.outcome !== ACCEPTED_PROPOSAL_STATUS)
      throw new ProposalNotAcceptedError("Proposal has no recorded acceptance decision");
    if (!proposal.submitter)
      throw new ProposalSubmitterUnavailableError(
        "The published form collected no contact address for this proposal",
      );
    return {
      eventId,
      proposalId,
      title: proposal.title,
      abstract: proposal.abstract,
      format: formatOf(proposal),
      submitter: proposal.submitter,
      decidedAt: decision.decidedAt,
    };
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
        // Reviewers evaluate the proposal, never the person: the submitter is masked here rather
        // than left as a constant the storage layer happens to produce.
        return { assignment, proposal: withoutSubmitter(proposal), plan, conflict, evaluation };
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
