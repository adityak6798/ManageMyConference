export type ReviewCriterion = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly minScore: number;
  readonly maxScore: number;
};

export type EvaluationPlan = {
  readonly eventId: string;
  readonly criteria: readonly ReviewCriterion[];
  readonly updatedAt: string;
};

export type ReviewAssignment = {
  readonly id: string;
  readonly eventId: string;
  readonly proposalId: string;
  readonly reviewerId: string;
  readonly createdAt: string;
};

export type ReviewConflict = {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly reason: string;
  readonly declaredAt: string;
};

export type EvaluationScore = { readonly criterionId: string; readonly score: number };

export type Evaluation = {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly scores: readonly EvaluationScore[];
  readonly notes: string;
  readonly state: "draft" | "completed";
  readonly updatedAt: string;
  readonly completedAt?: string;
};

export type ReviewOutcome = {
  readonly eventId: string;
  readonly proposalId: string;
  readonly completedEvaluationCount: number;
  readonly averageScore: number;
  readonly updatedAt: string;
};

/**
 * The two proposal statuses the review domain reserves.
 *
 * Organizers configure their own status set (`PRD-ABS-001`), but acceptance is not a free-form
 * label: it is the transition the content domain acts on, so these two keys always exist and can
 * never be removed while a proposal sits in them.
 */
export const ACCEPTED_PROPOSAL_STATUS = "accepted";
export const DECLINED_PROPOSAL_STATUS = "declined";
export const RESERVED_PROPOSAL_STATUSES = [
  { key: ACCEPTED_PROPOSAL_STATUS, label: "Accepted", sortOrder: 90 },
  { key: DECLINED_PROPOSAL_STATUS, label: "Declined", sortOrder: 91 },
] as const;

export type DecisionOutcome = typeof ACCEPTED_PROPOSAL_STATUS | typeof DECLINED_PROPOSAL_STATUS;

/**
 * A recorded acceptance decision.
 *
 * The proposal status is the board column an organizer can rename or reorder; this record is the
 * decision itself — who made it, when, and why — and it is the only thing that authorizes a
 * proposal to become program content.
 */
export type ProposalDecision = {
  readonly eventId: string;
  readonly proposalId: string;
  readonly outcome: DecisionOutcome;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note: string;
};

export type ReviewCompletedEvent = {
  readonly type: "EVT-REVIEW-COMPLETED";
  readonly version: 1;
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly proposalId: string;
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
};
