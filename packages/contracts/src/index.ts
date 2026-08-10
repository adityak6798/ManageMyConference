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
