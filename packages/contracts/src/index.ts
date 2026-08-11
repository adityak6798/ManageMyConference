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
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
  "review:evaluate",
]);

// @spec PRD-AGD-001
export const agendaIdParamsSchema = z.object({ eventId: z.string().uuid() });
export const agendaPlacementSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  roomId: z.string().min(1),
  trackId: z.string().min(1),
  slotId: z.string().min(1),
});
export const agendaResourcesSchema = z
  .object({
    rooms: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(120) })),
    tracks: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    ),
    slots: z
      .array(
        z.object({
          id: z.string().min(1),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime(),
        }),
      )
      .superRefine((slots, context) => {
        for (const [index, slot] of slots.entries())
          if (Date.parse(slot.startsAt) >= Date.parse(slot.endsAt))
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "endsAt"],
              message: "End must be after start",
            });
      }),
  })
  .superRefine((resources, context) => {
    for (const key of ["rooms", "tracks", "slots"] as const) {
      const ids = resources[key].map(({ id }) => id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} IDs must be unique`,
        });
    }
  });
export const agendaDraftSchema = z.object({
  eventId: z.string().uuid(),
  rooms: z.array(z.object({ id: z.string(), name: z.string() })),
  tracks: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  slots: z.array(
    z.object({ id: z.string(), startsAt: z.string().datetime(), endsAt: z.string().datetime() }),
  ),
  sessions: z.array(
    z.object({ id: z.string(), title: z.string(), speakerIds: z.array(z.string()) }),
  ),
  placements: z.array(agendaPlacementSchema),
  conflicts: z.array(
    z.object({
      kind: z.enum(["ROOM_OVERLAP", "SPEAKER_OVERLAP", "SESSION_OVERLAP", "MISSING_SESSION"]),
      placementId: z.string(),
      conflictingPlacementId: z.string(),
      resourceId: z.string(),
      message: z.string(),
    }),
  ),
});
export type AgendaDraftDto = z.infer<typeof agendaDraftSchema>;
export const publishedScheduleSchema = z.object({
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string(),
  agenda: agendaDraftSchema.omit({ conflicts: true }),
});
export const publicScheduleSchema = publishedScheduleSchema.omit({ publishedBy: true });
export type PublicScheduleDto = z.infer<typeof publicScheduleSchema>;
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

// @spec PRD-COM-001 PRD-INT-001
export const deliveryChannelSchema = z.enum(["email", "airtable", "accelevents"]);
export const deliveryStateSchema = z.enum(["queued", "retrying", "succeeded", "terminal"]);
export const triggerTypeSchema = z.enum([
  "speaker.invited",
  "reviewer.assigned",
  "organizer.digest",
  "projection.requested",
]);
export const createTemplateInputSchema = z.object({
  organizationId: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  version: z.number().int().positive(),
  channel: deliveryChannelSchema,
  subject: z.string().max(200).nullable(),
  body: z.string().min(1).max(100_000),
});
export const triggerDeliveryInputSchema = z
  .object({
    organizationId: z.string().uuid(),
    eventId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    triggerType: triggerTypeSchema,
    channel: deliveryChannelSchema,
    recipientRef: z.string().trim().min(1).max(500),
    payload: z.record(z.unknown()),
    templateKey: z.string().trim().min(1).max(80).optional(),
    templateVersion: z.number().int().positive().optional(),
    projectionVersion: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    if (input.channel === "email" && !input.templateKey)
      context.addIssue({
        code: "custom",
        path: ["templateKey"],
        message: "Email delivery requires a template",
      });
    if (input.channel === "email" && input.triggerType === "projection.requested")
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message: "Projection triggers require a projection provider",
      });
    if (input.channel !== "email" && input.triggerType !== "projection.requested")
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message: "Projection providers require a projection trigger",
      });
    if (input.channel !== "email" && input.projectionVersion === undefined)
      context.addIssue({
        code: "custom",
        path: ["projectionVersion"],
        message: "Projection delivery requires a version",
      });
  });
export const communicationsHistoryParamsSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(500).optional(),
});
export const retryDeliveryInputSchema = z.object({ organizationId: z.string().uuid() });
export const deliveryIdParamsSchema = z.object({ deliveryId: z.string().min(1) });
export const messageTemplateSchema = createTemplateInputSchema.extend({
  id: z.string(),
  createdAt: z.string().datetime(),
});
export const deliverySchema = z.object({
  id: z.string(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  idempotencyKey: z.string(),
  triggerType: triggerTypeSchema,
  channel: deliveryChannelSchema,
  templateId: z.string().nullable(),
  templateVersion: z.number().int().positive().nullable(),
  recipientRef: z.string(),
  payload: z.record(z.unknown()),
  projectionVersion: z.number().int().positive().nullable(),
  state: deliveryStateSchema,
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime(),
  leaseToken: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const deliveryAttemptSchema = z.object({
  id: z.string(),
  deliveryId: z.string(),
  sequence: z.number().int().positive(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  outcome: z.enum(["succeeded", "retryable_failure", "terminal_failure"]),
  providerReference: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export const templateResponseSchema = z.object({ template: messageTemplateSchema });
export const deliveryResponseSchema = z.object({ delivery: deliverySchema });
export const communicationsHistoryResponseSchema = z.object({
  history: z.array(
    z.object({ delivery: deliverySchema, attempts: z.array(deliveryAttemptSchema) }),
  ),
  nextCursor: z.string().nullable(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;
export type TriggerDeliveryInput = z.infer<typeof triggerDeliveryInputSchema>;
export type DeliveryDto = z.infer<typeof deliverySchema>;
export type CommunicationsHistoryDto = z.infer<typeof communicationsHistoryResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "AGENDA_CONFLICT",
  // The unauthenticated CFP submission route is throttled per client and event; a caller
  // that exceeds the window is told so rather than being given a misleading 4xx.
  "RATE_LIMITED",
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
/**
 * A user identity-access reports as assignable on this event. Ids are opaque identity strings
 * (`seed-organizer`), not UUIDs, so the CRM never invents an owner the directory does not know.
 */
export const prospectOwnerSchema = z.object({ id: z.string(), name: z.string() });
export const prospectOwnerListResponseSchema = z.object({
  owners: z.array(prospectOwnerSchema),
});
export type ProspectOwnerDto = z.infer<typeof prospectOwnerSchema>;

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
/**
 * Acceptance names a proposal and nothing else.
 *
 * Title, abstract, format and speaker identity are resolved server-side through the review
 * domain's public application interface (`ARC-FLOW-001`); a client that could supply them could
 * also invent them, which is how a fabricated proposal id used to create a session with a speaker
 * who had never applied. Organizers refine the session afterwards with
 * `PATCH /api/content-sessions/{sessionId}`.
 */
export const acceptContentInputSchema = z.object({ proposalId: z.string().uuid() });
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
  // Optional so a client written against the pre-decision shape still parses this response;
  // the server always sends it.
  decisions: z.array(proposalDecisionSchema).optional(),
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
// @spec PRD-CFP-001 PRD-CFP-002
export const cfpFieldTypeSchema = z.enum(["short_text", "long_text", "email", "select"]);
/**
 * The longest answer each field type accepts when the organizer states no explicit limit.
 *
 * The CFP domain repeats these numbers in `apps/api/src/domain/cfp/cfp.ts` because the
 * application layer may not import this package; the two must stay in agreement. The
 * authoritative value for any published form is the `maxLength` persisted on its fields,
 * which is what both the form builder and `validateAnswers` read.
 */
export const CFP_FIELD_MAX_LENGTHS = {
  short_text: 200,
  long_text: 5_000,
  // RFC 5321 section 4.5.3.1.3 caps a forward path at 256 octets including the angle brackets.
  email: 254,
  select: 120,
} as const satisfies Record<z.infer<typeof cfpFieldTypeSchema>, number>;
/** The longest answer any single field may accept, and the cap on an explicit `maxLength`. */
export const CFP_ANSWER_MAX_LENGTH = 10_000;
/** Answers are keyed by field id, so a submission can never carry more keys than a form has. */
export const CFP_ANSWER_MAX_FIELDS = 40;
export const cfpFieldSchema = z.object({
  id: z.string().min(1).max(80),
  type: cfpFieldTypeSchema,
  label: z.string().trim().min(1).max(120),
  guidance: z.string().trim().max(500).default(""),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /**
   * The longest answer this field accepts. Optional so forms saved before limits existed
   * still parse; `cfpFieldMaxLength` supplies the type default for those.
   */
  maxLength: z.number().int().min(1).max(CFP_ANSWER_MAX_LENGTH).optional(),
});
/** The limit the form builder must advertise and the validator must enforce, for one field. */
export const cfpFieldMaxLength = (field: {
  type: z.infer<typeof cfpFieldTypeSchema>;
  maxLength?: number | undefined;
}): number => field.maxLength ?? CFP_FIELD_MAX_LENGTHS[field.type];
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
/**
 * The only unauthenticated write in the API, so its body is bounded before it reaches a domain.
 *
 * A key is a field id (`cfpFieldSchema.id`), a value is one answer, and a submission can carry
 * no more keys than a form has fields (`cfpFieldsSchema.max(40)`). The per-value ceiling here is
 * the absolute maximum any field may declare; `validateAnswers` then enforces the narrower,
 * per-field `maxLength` the published form advertises.
 */
export const submitProposalInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: z
    .record(z.string().min(1).max(80), z.string().max(CFP_ANSWER_MAX_LENGTH))
    .refine((answers) => Object.keys(answers).length <= CFP_ANSWER_MAX_FIELDS, {
      message: `A proposal carries at most ${CFP_ANSWER_MAX_FIELDS} answers`,
    }),
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

// @spec PRD-PUB-001
export const routeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const ianaTimezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    // ERROR-INTENT: Intl reports unsupported IANA zones by throwing.
    return false;
  }
}, "Timezone must be a valid IANA time zone");
export const publicSpeakerSchema = z.object({
  slug: routeSlugSchema,
  name: z.string(),
  bio: z.string(),
  // Composed from the speaker profile's `organization`. It was published as `headline`,
  // which promised a job title and delivered an employer.
  organization: z.string(),
  photoUrl: z.string().optional(),
});
export const publicSessionSchema = z.object({
  slug: routeSlugSchema,
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  track: z.string(),
  speakerSlugs: z.array(routeSlugSchema),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  room: z.string().optional(),
});
export const publicEventProjectionSchema = z.object({
  event: z.object({
    eventId: z.string().uuid(),
    slug: routeSlugSchema,
    name: z.string(),
    summary: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
    timezone: ianaTimezoneSchema,
    venue: z.string(),
  }),
  cfp: z.object({
    title: z.string(),
    description: z.string(),
    status: z.enum(["open", "closed"]),
    publishedAt: z.string().datetime().nullable(),
    submissionUrl: z.string(),
  }),
  sessions: z.array(publicSessionSchema),
  speakers: z.array(publicSpeakerSchema),
});
export type PublicEventProjectionDto = z.infer<typeof publicEventProjectionSchema>;
export const publicEventResponseSchema = z.object({ projection: publicEventProjectionSchema });
export const publicEventSlugParamsSchema = z.object({ slug: routeSlugSchema });
export const publicationPreviewResponseSchema = z.object({
  publication: z.object({
    eventId: z.string().uuid(),
    slug: routeSlugSchema,
    state: z.enum(["draft", "published", "unpublished"]),
    draft: publicEventProjectionSchema,
    published: publicEventProjectionSchema.nullable(),
    publishedAt: z.string().datetime().nullable(),
  }),
});
