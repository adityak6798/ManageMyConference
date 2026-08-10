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
  "agenda:manage",
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
  providerMode: z.literal("deterministic-fakes"),
  logFormat: z.literal("structured-json"),
});

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "AGENDA_CONFLICT",
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
