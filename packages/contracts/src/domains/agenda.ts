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
  /**
   * When each part of the board last changed, counted in board revisions.
   *
   * A session's number advances when it is placed, unplaced or moved, and nothing else moves it;
   * a slot's advances when that slot is retimed, and nothing else moves it. Rooms, tracks, and
   * slots being added or removed are deliberately absent: no derived condition depends on any of
   * them, and counting them would resurface decisions about conditions an added room cannot
   * affect. It is on the wire because a consumer storing a decision about a *derived* condition —
   * the operational inbox's dismissals — needs to tell one occurrence of that condition from the
   * next, and the identifiers a condition is made of are reused exactly when it is resolved and
   * recreated (`PRD-OPS-002`, issue #180).
   */
  occurrences: z.object({
    sessions: z.record(z.string(), z.number().int().nonnegative()),
    slots: z.record(z.string(), z.number().int().nonnegative()),
  }),
  conflicts: z.array(
    z.object({
      kind: z.enum(["ROOM_OVERLAP", "SPEAKER_OVERLAP", "SESSION_OVERLAP", "MISSING_SESSION"]),
      placementId: z.string(),
      conflictingPlacementId: z.string(),
      resourceId: z.string(),
      message: z.string(),
      /** The board revision this clash began at; the same three ids at a later number is a new one. */
      occurrence: z.number().int().nonnegative(),
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
 * The board after an assisted pass, plus what it seated and what it could not.
 *
 * `unplaced` is part of the result rather than an error: a pass that seats eleven of twelve
 * sessions succeeded, and the twelfth needs an explanation the organizer can act on, not a
 * failed request.
 *
 * `placed` names the sessions *this* pass seated. Only the server knows that: a client can
 * compare the board it sent against the board it got back, but the difference also contains
 * whatever another organizer did in the same seconds, so a count taken there credits this
 * action with someone else's drag — or misses a session the client never knew was unscheduled.
 * The control announces what it did, so what it did has to be reported rather than inferred.
 */
export const agendaAssistedDraftSchema = agendaDraftSchema.extend({
  placed: z.array(z.string()),
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
  /*
   * A snapshot carries neither the conflicts nor the occurrences. Both describe the *draft* — what
   * is wrong with it now, and when each part of it last moved — and a frozen programme is not a
   * record of how it was edited.
   */
  agenda: agendaDraftSchema.omit({ conflicts: true, occurrences: true }),
});
