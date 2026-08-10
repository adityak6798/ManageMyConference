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

// @spec PRD-PUB-001
export const routeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const ianaTimezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      // ERROR-INTENT: Intl signals unsupported IANA zones by throwing; schema validation returns false.
      return false;
    }
  },
  { message: "Timezone must be a valid IANA time zone" },
);
export const publicSpeakerSchema = z.object({
  slug: routeSlugSchema,
  name: z.string(),
  bio: z.string(),
  headline: z.string(),
  photoUrl: z.string().url().optional(),
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
    opensAt: z.string().datetime(),
    closesAt: z.string().datetime(),
    submissionUrl: z.string().url(),
  }),
  sessions: z.array(publicSessionSchema),
  speakers: z.array(publicSpeakerSchema),
});
export type PublicEventProjectionDto = z.infer<typeof publicEventProjectionSchema>;
export const publicEventResponseSchema = z.object({ projection: publicEventProjectionSchema });
export const publicEventSlugParamsSchema = z.object({
  slug: routeSlugSchema,
});
export const publicationPreviewResponseSchema = z.object({
  publication: z.object({
    eventId: z.string().uuid(),
    slug: z.string(),
    state: z.enum(["draft", "published", "unpublished"]),
    draft: publicEventProjectionSchema,
    published: publicEventProjectionSchema.nullable(),
    publishedAt: z.string().datetime().nullable(),
  }),
});
