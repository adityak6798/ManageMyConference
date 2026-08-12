import { z } from "zod";

// @spec PRD-ABS-001 PRD-REV-001
export const proposalStatusSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_-]+$/);
export const proposalStatusDefinitionSchema = z.object({
  key: proposalStatusSchema,
  label: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().nonnegative(),
});
export const configureProposalStatusesInputSchema = z.object({
  statuses: z.array(proposalStatusDefinitionSchema).min(1).max(20),
});
export const reviewOrganizerQuerySchema = z.object({ status: proposalStatusSchema.optional() });
export const reviewEventParamsSchema = z.object({ eventId: z.string().uuid() });
export const reviewAssignmentParamsSchema = z.object({
  eventId: z.string().uuid(),
  assignmentId: z.string().uuid(),
});
export const proposalSubmitterSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});
export const proposalSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string(),
  abstract: z.string(),
  /** The submitter's display name, or the mask the reviewer projection substitutes for it. */
  submitterName: z.string(),
  /**
   * Organizer-only contact details, derived from the answers using the published form's field
   * types. `null` in the reviewer queue (blind review) and for a form that collected no email.
   */
  submitter: proposalSubmitterSchema.nullable(),
  coAuthors: z.array(z.object({ name: z.string(), role: z.string() })).optional(),
  /** Never carries an `email`-typed answer; contact details live only in `submitter`. */
  answers: z.array(
    z.object({
      fieldId: z.string(),
      label: z.string(),
      type: z.enum(["short_text", "long_text", "select"]),
      value: z.string(),
    }),
  ),
  status: proposalStatusSchema,
});
// @spec PRD-REV-001 PRD-CNT-001
export const proposalDecisionOutcomeSchema = z.enum(["accepted", "declined"]);
export const proposalDecisionSchema = z.object({
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
  outcome: proposalDecisionOutcomeSchema,
  decidedBy: z.string(),
  decidedAt: z.string().datetime(),
  note: z.string(),
});
export const recordProposalDecisionInputSchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(100),
  outcome: proposalDecisionOutcomeSchema,
  note: z.string().trim().max(1000).default(""),
});
export type RecordProposalDecisionInput = z.infer<typeof recordProposalDecisionInputSchema>;
/**
 * What became of the content half of one accepted proposal.
 *
 * Accepting is two domains deep — the review decision authorizes the session — but it is one
 * request: the transport records the decision and then runs content acceptance. The two are not
 * one transaction, so this says which of them happened.
 *
 * - `content`: the decision is recorded and `sessionId` names the session it produced.
 * - `decision_only`: the decision is recorded and durable, but the content domain refused the
 *   session and said why in `detail`/`fieldErrors`. Nothing is lost and nothing is half-written:
 *   re-posting the identical decision overwrites it and retries the session, so a retry heals
 *   the gap once the cause is gone.
 */
export const proposalAcceptanceSchema = z.object({
  proposalId: z.string().uuid(),
  state: z.enum(["content", "decision_only"]),
  sessionId: z.string().uuid().nullable(),
  detail: z.string(),
  fieldErrors: z.record(z.array(z.string())),
});
export type ProposalAcceptanceDto = z.infer<typeof proposalAcceptanceSchema>;
const reviewCriterionBaseSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300),
  weight: z.number().positive().max(100).optional(),
});
const numericReviewCriterionSchema = reviewCriterionBaseSchema
  .extend({
    type: z.literal("numeric").optional(),
    minScore: z.number().int().min(0).max(10),
    maxScore: z.number().int().min(1).max(10),
  })
  .refine((value) => value.maxScore > value.minScore, {
    message: "Maximum score must exceed minimum score",
    path: ["maxScore"],
  });
const dropdownReviewCriterionSchema = reviewCriterionBaseSchema.extend({
  type: z.literal("dropdown"),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(20),
});
const textReviewCriterionSchema = reviewCriterionBaseSchema.extend({
  type: z.literal("text"),
  maxLength: z.number().int().min(1).max(5000),
});
export const reviewCriterionSchema = z.union([
  numericReviewCriterionSchema,
  dropdownReviewCriterionSchema,
  textReviewCriterionSchema,
]);
export const reviewPlanSchema = z.object({
  eventId: z.string().uuid(),
  criteria: z.array(reviewCriterionSchema),
  updatedAt: z.string().datetime(),
});
export const configureReviewPlanInputSchema = z.object({
  criteria: z
    .array(reviewCriterionSchema)
    .min(1)
    .max(12)
    .refine((criteria) => criteria.some(({ type }) => !type || type === "numeric"), {
      message: "At least one numeric criterion is required for the aggregate",
    }),
});
export const reviewAssignmentSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
  reviewerId: z.string(),
  round: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export const assignReviewersInputSchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(100),
  reviewerId: z.string().trim().min(1),
});
export const distributeReviewersInputSchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(100),
  reviewerIds: z.array(z.string().trim().min(1)).min(1).max(100),
  maxAssignmentsPerReviewer: z.number().int().positive().max(100),
  round: z.number().int().positive().optional(),
});
export const advanceReviewRoundInputSchema = z.object({
  fromStatus: proposalStatusSchema,
  reviewerIds: z.array(z.string().trim().min(1)).min(1).max(100),
  maxAssignmentsPerReviewer: z.number().int().positive().max(100),
  currentRound: z.number().int().nonnegative(),
});
export const bulkProposalTransitionInputSchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(100),
  toStatus: proposalStatusSchema,
});
export const proposalAuditSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
  fromStatus: proposalStatusSchema,
  toStatus: proposalStatusSchema,
  actorId: z.string(),
  occurredAt: z.string().datetime(),
});
export const reviewOutcomeSchema = z.object({
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
  round: z.number().int().positive(),
  completedEvaluationCount: z.number().int().nonnegative(),
  averageScore: z.number(),
  updatedAt: z.string().datetime(),
});
export const reviewProgressSchema = z.object({
  reviewerId: z.string(),
  assigned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  outstanding: z.number().int().nonnegative(),
});
export const evaluationScoreSchema = z
  .object({
    criterionId: z.string(),
    value: z.union([z.number(), z.string()]).optional(),
    score: z.number().optional(),
  })
  .refine((item) => item.value !== undefined || item.score !== undefined, {
    message: "A criterion value is required",
  });
export const evaluationSchema = z.object({
  assignmentId: z.string().uuid(),
  reviewerId: z.string(),
  scores: z.array(evaluationScoreSchema),
  notes: z.string(),
  state: z.enum(["draft", "completed"]),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export const reviewerOptionSchema = z.object({ id: z.string(), name: z.string() });
export const organizerReviewWorkspaceSchema = z.object({
  proposals: z.array(proposalSchema),
  plan: reviewPlanSchema.nullable(),
  assignments: z.array(reviewAssignmentSchema),
  outcomes: z.array(reviewOutcomeSchema),
  evaluations: z.array(evaluationSchema).optional(),
  audit: z.array(proposalAuditSchema),
  statuses: z.array(proposalStatusDefinitionSchema),
  /**
   * Who this organizer may hand an abstract to — the assignable list, which excludes the
   * signed-in organizer because the console has no reviewer queue for her to open.
   */
  reviewers: z.array(reviewerOptionSchema),
  /**
   * Every reviewer of the event, whoever is signed in: the directory an *existing* assignment's
   * name is resolved through. Who may be assigned and who is already assigned are two different
   * questions, and answering the second from `reviewers` printed a raw user id (`seed-organizer`)
   * in the Reviewers column for anyone the assignable list withholds. Optional so a client
   * written against the pre-directory shape still parses this response; the server always sends
   * it.
   */
  reviewerDirectory: z.array(reviewerOptionSchema).optional(),
  // Optional so a client written against the pre-decision shape still parses this response;
  // the server always sends it.
  decisions: z.array(proposalDecisionSchema).optional(),
  progress: z.array(reviewProgressSchema).optional(),
});
export const reviewConflictSchema = z.object({
  assignmentId: z.string().uuid(),
  reviewerId: z.string(),
  reason: z.string(),
  declaredAt: z.string().datetime(),
});
export const declareConflictInputSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const saveEvaluationInputSchema = z.object({
  scores: z.array(evaluationScoreSchema),
  notes: z.string().max(5000).default(""),
  complete: z.boolean().default(false),
});
export const reviewerQueueItemSchema = z.object({
  assignment: reviewAssignmentSchema,
  proposal: proposalSchema,
  plan: reviewPlanSchema.nullable(),
  conflict: reviewConflictSchema.nullable(),
  evaluation: evaluationSchema.nullable(),
});
export const reviewerQueueSchema = z.object({ assignments: z.array(reviewerQueueItemSchema) });
export const reviewPlanResponseSchema = z.object({ plan: reviewPlanSchema });
export const reviewAssignmentsResponseSchema = z.object({
  assignments: z.array(reviewAssignmentSchema),
});
export const advanceReviewRoundResponseSchema = z.object({
  round: z.number().int().positive(),
  assignments: z.array(reviewAssignmentSchema),
});
/**
 * The assignment that was removed, echoed back so the caller can name it in what it announces.
 * Removing an assignment is how a mis-assignment is corrected — and, when it was the last one,
 * how the rubric stops being locked by it.
 */
export const reviewAssignmentRemovalResponseSchema = z.object({
  assignment: reviewAssignmentSchema,
});
export const proposalTransitionResponseSchema = z.object({
  proposals: z.array(proposalSchema),
  mode: z.literal("atomic"),
});
export const proposalStatusesResponseSchema = z.object({
  statuses: z.array(proposalStatusDefinitionSchema),
});
export const proposalDecisionResponseSchema = z.object({
  proposals: z.array(proposalSchema),
  decisions: z.array(proposalDecisionSchema),
  /**
   * One entry per decided proposal for an accepted outcome, empty for a decline. Defaulted so a
   * client written against the pre-composition shape still parses this response.
   */
  acceptances: z.array(proposalAcceptanceSchema).default([]),
});
export const reviewConflictResponseSchema = z.object({ conflict: reviewConflictSchema });
export const evaluationResponseSchema = z.object({ evaluation: evaluationSchema });

export type OrganizerReviewWorkspaceDto = z.infer<typeof organizerReviewWorkspaceSchema>;
export type ReviewerQueueDto = z.infer<typeof reviewerQueueSchema>;
export type SaveEvaluationInput = z.infer<typeof saveEvaluationInputSchema>;
