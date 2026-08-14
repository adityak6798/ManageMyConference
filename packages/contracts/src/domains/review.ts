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
export const reviewSuggestionParamsSchema = z.object({
  eventId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  suggestionId: z.string().uuid(),
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
// @spec PRD-REV-001 PRD-ABS-001
export const reviewRoundStateSchema = z.enum(["draft", "open", "closed"]);
/**
 * `event` admits every reviewer staffed on the event; `named` admits only this round's pool.
 * A round an organizer creates is `named` by default, which is what makes membership in one round
 * not carry into another.
 */
export const reviewRoundPoolModeSchema = z.enum(["event", "named"]);
export const reviewRoundSchema = z.object({
  eventId: z.string().uuid(),
  /**
   * The round's number, and the key everything about it is stored under.
   *
   * `review_assignments.round`, `review_outcomes.round` and `review_suggestions.round` all carry
   * exactly this integer, which is how rounds became first-class over a deployed database without
   * rebuilding any of those tables (migration `1312`). Allocated by the server; a client never
   * chooses it.
   */
  sequence: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  /** `null` is unbounded on that side. */
  opensAt: z.string().datetime().nullable(),
  closesAt: z.string().datetime().nullable(),
  state: reviewRoundStateSchema,
  /** Whether reviewers in this round see the author. A correctness property, not a display one. */
  anonymized: z.boolean(),
  /** This round's own scorecard, or `null` to score against the event plan. */
  criteria: z.array(reviewCriterionSchema).nullable(),
  poolMode: reviewRoundPoolModeSchema,
  reviewerIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const reviewRoundTermsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  anonymized: z.boolean(),
  /**
   * Absent or null means "score against the event plan", which is what a round does when nobody
   * gives it a rubric of its own. Supplied, it must satisfy the same rules the event plan does —
   * at least one numeric criterion, unique ids — because an aggregate over a rubric with no
   * numeric criterion divides by zero.
   */
  criteria: z
    .array(reviewCriterionSchema)
    .min(1)
    .max(12)
    .refine((criteria) => criteria.some(({ type }) => !type || type === "numeric"), {
      message: "At least one numeric criterion is required for the aggregate",
    })
    .nullable()
    .optional(),
  poolMode: reviewRoundPoolModeSchema,
});
export const createReviewRoundInputSchema = reviewRoundTermsSchema.extend({
  state: reviewRoundStateSchema.default("draft"),
  reviewerIds: z.array(z.string().trim().min(1)).max(100).default([]),
});
export const updateReviewRoundInputSchema = reviewRoundTermsSchema.extend({
  state: reviewRoundStateSchema,
});
export const setReviewRoundPoolInputSchema = z.object({
  reviewerIds: z.array(z.string().trim().min(1)).max(100),
});
export const reviewRoundParamsSchema = z.object({
  eventId: z.string().uuid(),
  sequence: z.coerce.number().int().positive(),
});
/**
 * A round as a reviewer sees it: its terms, without its pool.
 *
 * `reviewerIds` is staffing information. A reviewer's queue carries the round so the surface can
 * name it, say whether it is taking work, and say whether the reader is reading blind — none of
 * which needs to know who else is scoring the same abstracts, and a blind round publishing that
 * would answer the one question a double-blind committee exists to keep closed.
 */
export const reviewerRoundSchema = reviewRoundSchema.omit({ reviewerIds: true });
export const reviewRoundResponseSchema = z.object({ round: reviewRoundSchema });
export const reviewRoundsResponseSchema = z.object({ rounds: z.array(reviewRoundSchema) });
/**
 * What became of one reviewer's reminder.
 *
 * `already_sent` is not a failure — it is the idempotency working — but the organizer has to see
 * the difference or they will press again. `nothing_outstanding` means the reviewer finished
 * between the page load and the click, and no message was sent because there was nothing to
 * remind them about.
 */
export const reviewReminderResultSchema = z.object({
  reviewerId: z.string(),
  outstanding: z.number().int().nonnegative(),
  state: z.enum(["queued", "already_sent", "unaddressable", "nothing_outstanding"]),
});
export const remindReviewersInputSchema = z.object({
  round: z.number().int().positive(),
  reviewerIds: z.array(z.string().trim().min(1)).min(1).max(100),
});
export const remindReviewersResponseSchema = z.object({
  reminders: z.array(reviewReminderResultSchema),
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
  /**
   * Which round this assignment belongs to. Optional, and defaulted to 1 by the server rather
   * than here, so a client written before rounds were first-class keeps working unchanged.
   */
  round: z.number().int().positive().optional(),
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
/**
 * The same counts, per round.
 *
 * Both shapes ship because neither answers the other's question: the event-wide row is "is
 * anybody late?", and this one is "is this round finished?". A single outstanding count that
 * pooled a closed first round with a live second one is the number that makes a reviewer look
 * behind when they are not. A reviewer with nothing in a round is omitted rather than listed as
 * 0/0.
 */
export const reviewRoundProgressSchema = reviewProgressSchema.extend({
  round: z.number().int().positive(),
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
  /**
   * Where this record's values started: written by hand, or seeded by accepting an AI suggestion.
   * Optional so a client written before the suggestion port still parses this response; the server
   * always sends it, and the value is never absent in storage.
   */
  source: z.enum(["manual", "suggested"]).optional(),
  /** The suggestion it was seeded from. Non-null exactly when `source` is `suggested`. */
  suggestionId: z.string().uuid().nullable().optional(),
});

// @spec PRD-AI-001 PORT-AI
/**
 * Which model drafted a suggestion, from which prompt, when, and against which version of the
 * abstract. Every field is required on the wire: a suggestion whose provenance a reviewer cannot
 * read is not one they can weigh, so there is no partial form of this object.
 */
export const suggestionProvenanceSchema = z.object({
  model: z.string(),
  promptVersion: z.string(),
  generatedAt: z.string().datetime(),
  proposalRevision: z.string(),
});
export const suggestedScoreSchema = z.object({
  criterionId: z.string(),
  value: z.union([z.number(), z.string()]),
  rationale: z.string(),
});
export const reviewSuggestionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  reviewerId: z.string(),
  proposalId: z.string().uuid(),
  round: z.number().int().positive(),
  summary: z.string(),
  scores: z.array(suggestedScoreSchema),
  /** `offered` until the reviewer answers. Nothing else can move it. */
  state: z.enum(["offered", "accepted", "rejected"]),
  provenance: suggestionProvenanceSchema,
  respondedBy: z.string().nullable(),
  respondedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export const respondToSuggestionInputSchema = z.object({
  response: z.enum(["accepted", "rejected"]),
  /**
   * Copy the drafted summary into the reviewer's private notes as part of this acceptance.
   *
   * Defaults to `false`, and the default is the point: model prose reaching a field organizers
   * read as the reviewer's own opinion has to be something the reviewer asked for, once, on this
   * acceptance — not something that happens because they pressed Accept.
   */
  includeSummaryInNotes: z.boolean().default(false),
});
export type RespondToSuggestionInput = z.infer<typeof respondToSuggestionInputSchema>;
export const reviewSuggestionResponseSchema = z.object({
  suggestion: reviewSuggestionSchema,
});
export const suggestionResponseResponseSchema = z.object({
  suggestion: reviewSuggestionSchema,
  /**
   * The reviewer's own draft, when they accepted. `null` on a rejection, which writes no
   * evaluation at all — and never a *completed* evaluation, which only the reviewer's separate
   * Complete action produces.
   */
  evaluation: evaluationSchema.nullable(),
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
  /**
   * Every round of this event with its pool, lowest sequence first. Optional so a client written
   * before rounds were first-class still parses this response; the server always sends it, and an
   * event that has never configured one is answered with the default `Round 1` rather than an
   * empty list.
   */
  rounds: z.array(reviewRoundSchema).optional(),
  roundProgress: z.array(reviewRoundProgressSchema).optional(),
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
  /**
   * The digest of the abstract as it is being sent right now. Compared against a suggestion's
   * `provenance.proposalRevision` so a draft written about text that has since been edited can be
   * labelled as such instead of shown as current. Optional for clients written before it existed.
   */
  proposalRevision: z.string().optional(),
  /**
   * Suggestions offered to this reviewer for this assignment, oldest first. Optional so a client
   * written against the pre-suggestion shape still parses this response, and absent rather than
   * empty when the deployment has no assistant; the server always sends it otherwise.
   */
  suggestions: z.array(reviewSuggestionSchema).optional(),
  /**
   * The round this assignment sits in, whose anonymization policy chose the projection above and
   * whose scorecard is the `plan` beside it. Optional for clients written before rounds.
   */
  round: reviewerRoundSchema.nullable().optional(),
  /**
   * Why this round is not taking work, or `null` when it is.
   *
   * Sent so the queue can say the round is closed before the reviewer types, rather than letting
   * them fill in a form whose save is refused.
   */
  roundClosedReason: z.string().nullable().optional(),
});
export const reviewerQueueSchema = z.object({
  assignments: z.array(reviewerQueueItemSchema),
  /**
   * Whether this deployment has a suggestion provider bound at all.
   *
   * The reviewer's surface offers a Draft control only when this is true, so "the whole review
   * workflow still works with the port switched off" is a state a client can actually render
   * rather than an assertion in a document. Optional for clients written before the port.
   */
  suggestionsEnabled: z.boolean().optional(),
});
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
