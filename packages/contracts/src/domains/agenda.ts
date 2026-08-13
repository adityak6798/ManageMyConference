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
/**
 * One session's stored schedule, as a reconciliation reports it.
 *
 * Plain strings rather than `.datetime()`, unlike every other instant in this module, and the
 * exception is the point: this surface exists to describe rows that may be *wrong*. A schema that
 * refused to describe a malformed stored value would make the diagnostic unusable at exactly the
 * moment it was needed. Everything an organizer would compare is here, because a report that
 * omitted `location` or `revisedAt` could call two rows equal that a calendar client does not.
 */
export const scheduleRevisionSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  location: z.string(),
  revision: z.number().int(),
  revisedAt: z.string(),
});
/**
 * Whether an event's stored schedule revisions still describe its publication history.
 *
 * Three kinds of divergence, kept apart because they fail in opposite directions (issue #169).
 * `missing` withholds mail that should go out — the session reads as unscheduled everywhere.
 * `phantom` sends mail that should not — a row for a session the programme no longer schedules,
 * which a Send mails an invitation for. `divergent` can do either, depending on whether the hour
 * or the revision is what went stale.
 *
 * The two watermarks answer a different question from the drift: the drift says what is wrong now,
 * the watermarks say whether anything had noticed. A divergence with equal watermarks means the
 * derived table was written behind the fold's back, which is a different fault from a publication
 * the fold never saw. They count *writes to the history*, not versions — two writes can carry the
 * same version, and the question is whether anything happened. `materializedWatermark` is null when
 * the table has never been derived, which is what migration `1602` leaves behind for every event
 * that had already published.
 */
export const scheduleReconciliationSchema = z.object({
  eventId: z.string().uuid(),
  publicationWatermark: z.number().int().nullable(),
  materializedWatermark: z.number().int().nullable(),
  /** How many publications the replay walked, which is the cost this answer actually paid. */
  publications: z.number().int().nonnegative(),
  /**
   * Whether the stored answer could be believed: the rows agree with the history *and* the
   * watermark says so. Both halves — an event whose rows are right but whose watermark migration
   * `1602` deliberately left unclaimed is **not** in sync, and is repaired to make it so.
   *
   * A statement about what was *found*, not about what was left behind. A `POST` that repaired
   * anything therefore answers `inSync: false` with `repaired: true`, and the proof it worked is
   * that the next `GET` answers `inSync: true`.
   */
  inSync: z.boolean(),
  /** Whether this call wrote the replayed answer back. Always false for the `GET`. */
  repaired: z.boolean(),
  drift: z.object({
    missing: z.array(z.string()),
    phantom: z.array(z.string()),
    divergent: z.array(
      z.object({
        sessionId: z.string(),
        stored: scheduleRevisionSchema,
        replayed: scheduleRevisionSchema,
      }),
    ),
  }),
});
export type ScheduleReconciliationDto = z.infer<typeof scheduleReconciliationSchema>;
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
