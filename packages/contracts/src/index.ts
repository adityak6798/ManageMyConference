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
  "crm:manage",
  "content:read",
  "content:manage",
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
  providerMode: z.literal("sql-r2"),
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

// @spec PRD-CRM-001
export const prospectStageSchema = z.enum([
  "identified",
  "contacted",
  "engaged",
  "invited",
  "converted",
]);
export const prospectContactSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  isPrimary: z.boolean(),
});
export const prospectActivitySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["note", "email", "call", "meeting", "stage-change", "conversion"]),
  summary: z.string(),
  private: z.boolean(),
  occurredAt: z.string().datetime(),
  actorId: z.string(),
});
export const prospectSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  name: z.string(),
  stage: prospectStageSchema,
  ownerId: z.string(),
  nextAction: z.string().nullable(),
  nextActionAt: z.string().datetime().nullable(),
  contacts: z.array(prospectContactSchema),
  activities: z.array(prospectActivitySchema),
  speakerId: z.string().uuid().nullable(),
  convertedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProspectDto = z.infer<typeof prospectSchema>;
export const createProspectInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  ownerId: z.string().trim().min(1),
  nextAction: z.string().trim().min(1).max(300).optional(),
  nextActionAt: z.string().datetime().optional(),
  contact: z.object({ name: z.string().trim().min(1).max(160), email: z.string().email() }),
});
const editableProspectStageSchema = z.enum(["identified", "contacted", "engaged", "invited"]);
export const updateProspectInputSchema = z
  .object({
    stage: editableProspectStageSchema.optional(),
    ownerId: z.string().trim().min(1).optional(),
    nextAction: z.string().trim().min(1).max(300).nullable().optional(),
    nextActionAt: z.string().datetime().nullable().optional(),
    activity: z
      .object({
        kind: z.enum(["note", "email", "call", "meeting", "stage-change"]),
        summary: z.string().trim().min(1).max(1000),
        private: z.boolean().default(true),
      })
      .optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(160),
        email: z.string().email(),
        isPrimary: z.boolean().default(false),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one change is required");
export const prospectPathSchema = z.object({
  eventId: z.string().uuid(),
  prospectId: z.string().uuid(),
});
export const prospectListQuerySchema = z.object({
  stage: prospectStageSchema.optional(),
  ownerId: z.string().optional(),
  overdue: z.enum(["true"]).optional(),
});
export const prospectResponseSchema = z.object({ prospect: prospectSchema });
export const prospectListResponseSchema = z.object({ prospects: z.array(prospectSchema) });

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export const contentSessionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string(),
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  speakerProfileIds: z.array(z.string().uuid()),
  tags: z.array(z.string()),
  tracks: z.array(z.string()),
  publicationState: z.enum(["draft", "ready", "published"]),
  schedule: z
    .object({
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      location: z.string(),
    })
    .optional(),
});
export const speakerProfileSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  userId: z.string(),
  sourcePersonId: z.string(),
  name: z.string(),
  email: z.string().email(),
  bio: z.string(),
  pronouns: z.string(),
  organization: z.string(),
  photoAssetId: z.string().uuid().optional(),
});
export const speakerTaskSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  title: z.string(),
  dueAt: z.string().datetime(),
  status: z.enum(["open", "complete"]),
  completedAt: z.string().datetime().optional(),
});
export const speakerAssetSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  name: z.string(),
  contentType: z.string(),
  storageKey: z.string(),
  visibility: z.enum(["private", "publishable"]),
  uploadedAt: z.string().datetime(),
});
export const speakerMessageSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  subject: z.string(),
  sentAt: z.string().datetime(),
});
export const contentWorkspaceSchema = z.object({
  sessions: z.array(contentSessionSchema),
  speakers: z.array(speakerProfileSchema),
  tasks: z.array(speakerTaskSchema),
  assets: z.array(speakerAssetSchema),
  messages: z.array(speakerMessageSchema),
});
export type ContentWorkspaceDto = z.infer<typeof contentWorkspaceSchema>;
export const acceptContentInputSchema = z
  .object({
    proposalId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(160),
    abstract: z.string().trim().min(1),
    format: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)),
    tracks: z.array(z.string().trim().min(1)),
    speakers: z
      .array(
        z.object({
          userId: z.string().min(1),
          sourcePersonId: z.string().min(1),
          name: z.string().trim().min(1),
          email: z.string().email(),
        }),
      )
      .min(1),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();
    input.speakers.forEach((speaker, index) => {
      if (seen.has(speaker.sourcePersonId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["speakers", index, "sourcePersonId"],
          message: "Each person may appear only once",
        });
      seen.add(speaker.sourcePersonId);
    });
  });
export type AcceptContentInput = z.infer<typeof acceptContentInputSchema>;
export const updateSpeakerProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bio: z.string().trim().max(2000),
  pronouns: z.string().trim().max(50),
  organization: z.string().trim().max(120),
});
export type UpdateSpeakerProfileInput = z.infer<typeof updateSpeakerProfileInputSchema>;
export const uploadSpeakerAssetInputSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  contentBase64: z
    .string()
    .min(1)
    .max(8_000_000)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      "Asset content must be valid base64",
    ),
});
export type UploadSpeakerAssetInput = z.infer<typeof uploadSpeakerAssetInputSchema>;
export const eventContentParamsSchema = z.object({ eventId: z.string().uuid() });
export const profileParamsSchema = z.object({ profileId: z.string().uuid() });
export const taskParamsSchema = z.object({ taskId: z.string().uuid() });
export const contentSessionParamsSchema = z.object({ sessionId: z.string().uuid() });
export const speakerAssetParamsSchema = z.object({ assetId: z.string().uuid() });
export const updateContentSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  abstract: z.string().trim().min(1),
  format: z.string().trim().min(1),
  speakerProfileIds: z.array(z.string().uuid()).min(1),
  tags: z.array(z.string().trim().min(1)),
  tracks: z.array(z.string().trim().min(1)),
  publicationState: z.enum(["draft", "ready", "published"]),
});
export type UpdateContentSessionInput = z.infer<typeof updateContentSessionInputSchema>;
export const requestSpeakerTaskInputSchema = z.object({
  profileId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  dueAt: z.string().datetime(),
});
export const recordSpeakerMessageInputSchema = z.object({
  profileId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200),
});
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
  eventId: z.string().uuid(),
  title: z.string(),
  abstract: z.string(),
  submitterName: z.string(),
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
// @spec PRD-CFP-001 PRD-CFP-002
export const cfpFieldTypeSchema = z.enum(["short_text", "long_text", "email", "select"]);
export const cfpFieldSchema = z.object({
  id: z.string().min(1).max(80),
  type: cfpFieldTypeSchema,
  label: z.string().trim().min(1).max(120),
  guidance: z.string().trim().max(500).default(""),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
});
export const cfpStatusSchema = z.enum(["draft", "open", "closed"]);
const cfpFieldsSchema = z
  .array(cfpFieldSchema)
  .min(1)
  .max(40)
  .superRefine((fields, context) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Field IDs must be unique",
        });
      seen.add(field.id);
      if (field.type === "select" && field.options.length === 0)
        context.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "Select fields need at least one option",
        });
    });
  });
export const saveCfpInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  fields: cfpFieldsSchema,
});
export const cfpFormSchema = saveCfpInputSchema.extend({
  eventId: z.string().uuid(),
  status: cfpStatusSchema,
  version: z.number().int().positive(),
  publishedAt: z.string().datetime().nullable(),
  publishedStatus: z.enum(["open", "closed"]).nullable(),
});
export const cfpResponseSchema = z.object({ cfp: cfpFormSchema });
export const cfpStateInputSchema = z.object({ state: z.enum(["publish", "close", "reopen"]) });
export const submitProposalInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: z.record(z.string()),
});
export const proposalConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  submittedAt: z.string().datetime(),
});
export const proposalConfirmationResponseSchema = z.object({
  submission: proposalConfirmationSchema,
});
export type CfpField = z.infer<typeof cfpFieldSchema>;
export type CfpFormDto = z.infer<typeof cfpFormSchema>;
export type SaveCfpInput = z.infer<typeof saveCfpInputSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
