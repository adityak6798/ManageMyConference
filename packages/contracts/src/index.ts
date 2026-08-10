import { z } from "zod";

// @spec PRD-EVT-001
export const createEventInputSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, "Event name is required").max(120),
  timezone: z.string().trim().min(1).default("America/Los_Angeles"),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  createdAt: z.string().datetime(),
});

export type EventDto = z.infer<typeof eventSchema>;
export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() });

export const eventListResponseSchema = z.object({ events: z.array(eventSchema) });
export const createEventResponseSchema = z.object({ event: eventSchema });
export const demoPersonaSchema = z.enum(["organizer", "reviewer", "speaker", "public"]);
export const demoSessionInputSchema = z.object({ persona: demoPersonaSchema });
export const demoSessionResponseSchema = z.object({ persona: demoPersonaSchema });
export const capabilitySchema = z.enum([
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "review:manage",
  "review:evaluate",
]);
export const sessionEventAccessSchema = z.object({
  eventId: z.string().uuid(),
  role: demoPersonaSchema,
  capabilities: z.array(capabilitySchema),
});
export const sessionResponseSchema = z.object({
  actor: z.object({ id: z.string(), name: z.string(), persona: demoPersonaSchema }),
  organizations: z.array(z.object({ id: z.string().uuid() })),
  eventAccess: z.array(sessionEventAccessSchema),
  capabilities: z.array(capabilitySchema),
});
export type SessionDto = z.infer<typeof sessionResponseSchema>;
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  checks: z.object({
    database: z.literal("configured"),
    sessionSigning: z.enum(["configured", "disabled"]),
  }),
  providerMode: z.literal("deterministic-fakes"),
  logFormat: z.literal("structured-json"),
});

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    correlationId: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

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
export const proposalSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string(),
  abstract: z.string(),
  submitterName: z.string(),
  status: proposalStatusSchema,
});
export const reviewCriterionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9_-]+$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300),
    minScore: z.number().int().min(0).max(10),
    maxScore: z.number().int().min(1).max(10),
  })
  .refine((value) => value.maxScore > value.minScore, {
    message: "Maximum score must exceed minimum score",
    path: ["maxScore"],
  });
export const reviewPlanSchema = z.object({
  eventId: z.string().uuid(),
  criteria: z.array(reviewCriterionSchema),
  updatedAt: z.string().datetime(),
});
export const configureReviewPlanInputSchema = z.object({
  criteria: z.array(reviewCriterionSchema).min(1).max(12),
});
export const reviewAssignmentSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
  reviewerId: z.string(),
  createdAt: z.string().datetime(),
});
export const assignReviewersInputSchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(100),
  reviewerId: z.string().trim().min(1),
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
  completedEvaluationCount: z.number().int().nonnegative(),
  averageScore: z.number(),
  updatedAt: z.string().datetime(),
});
export const reviewerOptionSchema = z.object({ id: z.string(), name: z.string() });
export const organizerReviewWorkspaceSchema = z.object({
  proposals: z.array(proposalSchema),
  plan: reviewPlanSchema.nullable(),
  assignments: z.array(reviewAssignmentSchema),
  outcomes: z.array(reviewOutcomeSchema),
  audit: z.array(proposalAuditSchema),
  statuses: z.array(proposalStatusDefinitionSchema),
  reviewers: z.array(reviewerOptionSchema),
});
export const reviewConflictSchema = z.object({
  assignmentId: z.string().uuid(),
  reviewerId: z.string(),
  reason: z.string(),
  declaredAt: z.string().datetime(),
});
export const declareConflictInputSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const evaluationScoreSchema = z.object({ criterionId: z.string(), score: z.number().int() });
export const evaluationSchema = z.object({
  assignmentId: z.string().uuid(),
  reviewerId: z.string(),
  scores: z.array(evaluationScoreSchema),
  notes: z.string(),
  state: z.enum(["draft", "completed"]),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
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
export const proposalTransitionResponseSchema = z.object({
  proposals: z.array(proposalSchema),
  mode: z.literal("atomic"),
});
export const proposalStatusesResponseSchema = z.object({
  statuses: z.array(proposalStatusDefinitionSchema),
});
export const reviewConflictResponseSchema = z.object({ conflict: reviewConflictSchema });
export const evaluationResponseSchema = z.object({ evaluation: evaluationSchema });

export type OrganizerReviewWorkspaceDto = z.infer<typeof organizerReviewWorkspaceSchema>;
export type ReviewerQueueDto = z.infer<typeof reviewerQueueSchema>;
export type SaveEvaluationInput = z.infer<typeof saveEvaluationInputSchema>;
