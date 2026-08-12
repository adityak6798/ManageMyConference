import { z } from "zod";

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
/**
 * Which sessions the assisted pass should seat. Omitting `sessionIds` means every unscheduled
 * session, which is the "generate a draft" case; naming them is the "place these" case.
 */
export const agendaAutoPlaceSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).optional(),
});
/**
 * The board after an assisted pass, plus what it could not seat and why.
 *
 * `unplaced` is part of the result rather than an error: a pass that seats eleven of twelve
 * sessions succeeded, and the twelfth needs an explanation the organizer can act on, not a
 * failed request.
 */
export const agendaAssistedDraftSchema = agendaDraftSchema.extend({
  unplaced: z.array(z.object({ sessionId: z.string(), title: z.string(), reason: z.string() })),
});
export type AgendaAssistedDraftDto = z.infer<typeof agendaAssistedDraftSchema>;
/**
 * Optional idempotency key for the publish command.
 *
 * Supplying it means "this is a retry of one intent": the same key returns the publication the
 * first attempt committed instead of freezing the board again. Omitting it means a new intent,
 * which is what an organizer pressing Publish a second time after editing actually wants.
 */
export const agendaPublicationHeadersSchema = z.object({
  "idempotency-key": z.string().min(1).max(200).optional(),
});
export const publishedScheduleSchema = z.object({
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string(),
  agenda: agendaDraftSchema.omit({ conflicts: true }),
});
