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
  "content:read",
  "content:manage",
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
