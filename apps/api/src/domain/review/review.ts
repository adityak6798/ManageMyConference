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
