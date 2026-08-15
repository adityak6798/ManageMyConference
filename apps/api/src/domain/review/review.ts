import type { EvaluationSource } from "./suggestion";

export type ReviewCriterion = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly weight?: number | undefined;
} & (
  | { readonly type?: "numeric" | undefined; readonly minScore: number; readonly maxScore: number }
  | { readonly type: "dropdown"; readonly options: readonly string[] }
  | { readonly type: "text"; readonly maxLength: number }
);

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
  readonly round?: number;
  readonly createdAt: string;
};

export type ReviewConflict = {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly reason: string;
  readonly declaredAt: string;
};

export type EvaluationScore = {
  readonly criterionId: string;
  readonly value?: number | string | undefined;
  readonly score?: number | undefined;
};

export type Evaluation = {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly scores: readonly EvaluationScore[];
  readonly notes: string;
  readonly state: "draft" | "completed";
  readonly updatedAt: string;
  readonly completedAt?: string;
  /**
   * Whether this record started from an accepted AI suggestion or was written by hand.
   *
   * Optional on the type only so a fixture built before `1310` still satisfies it; storage
   * defaults it to `manual` and never stores null. See `EvaluationSource`.
   */
  readonly source?: EvaluationSource;
  /** The suggestion this record was seeded from. Present exactly when `source` is `suggested`. */
  readonly suggestionId?: string | null;
};

export type ReviewOutcome = {
  readonly eventId: string;
  readonly proposalId: string;
  readonly round?: number;
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
export const WAITLISTED_PROPOSAL_STATUS = "waitlisted";
export const REVISION_REQUESTED_PROPOSAL_STATUS = "revision_requested";
export const RESERVED_PROPOSAL_STATUSES = [
  { key: ACCEPTED_PROPOSAL_STATUS, label: "Accepted", sortOrder: 90 },
  { key: WAITLISTED_PROPOSAL_STATUS, label: "Waitlist", sortOrder: 91 },
  { key: REVISION_REQUESTED_PROPOSAL_STATUS, label: "Request revision", sortOrder: 92 },
  { key: DECLINED_PROPOSAL_STATUS, label: "Declined", sortOrder: 93 },
] as const;

export type DecisionOutcome = (typeof RESERVED_PROPOSAL_STATUSES)[number]["key"];

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
  /**
   * How many times this proposal has actually been decided.
   *
   * Advances only when the outcome changes, so re-deciding the same way — the retry `decide`
   * documents as how a half-finished decision heals — leaves it alone, while accept → decline →
   * accept reaches 3. It is the one fact that separates those two, because every other column
   * moves on both. Allocated by storage inside the upsert, never by a caller.
   */
  readonly revision: number;
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
