// @spec PRD-AGD-001
export interface AgendaRoom {
  readonly id: string;
  readonly name: string;
}
export interface AgendaTrack {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}
export interface AgendaSlot {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
}
export interface SchedulableSession {
  readonly id: string;
  readonly title: string;
  readonly speakerIds: readonly string[];
}
export interface Placement {
  readonly id: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly trackId: string;
  readonly slotId: string;
}
export type ConflictKind =
  | "ROOM_OVERLAP"
  | "SPEAKER_OVERLAP"
  | "SESSION_OVERLAP"
  | "MISSING_SESSION";
export interface AgendaConflict {
  readonly kind: ConflictKind;
  readonly placementId: string;
  readonly conflictingPlacementId: string;
  readonly resourceId: string;
  readonly message: string;
}

export interface AgendaDraft {
  readonly eventId: string;
  readonly rooms: readonly AgendaRoom[];
  readonly tracks: readonly AgendaTrack[];
  readonly slots: readonly AgendaSlot[];
  readonly sessions: readonly SchedulableSession[];
  readonly placements: readonly Placement[];
}

/**
 * When and where one agenda puts a session.
 *
 * This is the *only* statement a session's time can come from: the slot supplies the instants
 * and the room supplies the place. `content_sessions` used to carry its own copy of all three,
 * written by nothing but the seed, so a speaker's calendar and the published programme could —
 * and did — name different days for the same talk.
 */
export interface PlacedSessionTime {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string;
}

/**
 * Where this agenda places each session, keyed by session id.
 *
 * A placement whose slot the agenda no longer holds yields nothing at all rather than a
 * half-time: a session with an unusable start is unscheduled, not scheduled at an unknown hour.
 * A room that has since been removed leaves the location empty and keeps the time, because the
 * hour is still true. Two placements of one session is a `SESSION_OVERLAP` conflict that blocks
 * publication, so the last one wins here and no published snapshot can reach that branch.
 */
export function placedSessionTimes(agenda: AgendaDraft): ReadonlyMap<string, PlacedSessionTime> {
  const slots = new Map(agenda.slots.map((slot) => [slot.id, slot]));
  const rooms = new Map(agenda.rooms.map((room) => [room.id, room.name]));
  const placed = new Map<string, PlacedSessionTime>();
  for (const placement of agenda.placements) {
    const slot = slots.get(placement.slotId);
    if (!slot) continue;
    placed.set(placement.sessionId, {
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      location: rooms.get(placement.roomId) ?? "",
    });
  }
  return placed;
}

/**
 * Where a session sits, and at which publication that last meaningfully changed.
 *
 * `revision` is a publication version rather than a counter of its own, so it is comparable
 * with the publication history and monotonic by construction. Both fields are read by the
 * speaker calendar invite: `revision` distinguishes A -> unscheduled -> A from the first A even
 * though the times are identical, and `revisedAt` says when that happened.
 */
export interface SessionScheduleRevision extends PlacedSessionTime {
  readonly revision: number;
  readonly revisedAt: string;
}

/**
 * The per-session revisions one publication produces, given the ones in force before it.
 *
 * Two rules, and both are load-bearing for what a speaker's calendar client does with the
 * result. They are stated here, once, because this fold now runs in two places that must not
 * be allowed to disagree: forward, inside the batch that commits a publication, and backwards
 * over history, in `1601`'s backfill.
 *
 * *An unchanged placement does not advance a revision.* The comparison is on the triple
 * `(startsAt, endsAt, location)` and nothing else — not placement id, room id, track id or slot
 * id. Republishing an untouched board, or moving a session to a different slot that happens to
 * carry the same hour in the same room, is not a revision, because nothing a calendar holds
 * would differ. Advancing it anyway would resend an identical invitation to every speaker on
 * every republication.
 *
 * *Absence resets rather than freezes.* A publication that does not place a session drops it
 * from the map entirely, so a session that returns later at an identical time gets the
 * *returning* publication's version, which is strictly higher. Carrying the old revision
 * forward through the absence would make the return compare equal to the original placement,
 * and the REQUEST that puts the talk back on the speaker's calendar would be suppressed as a
 * duplicate of the one that first put it there (issue #136).
 */
export function nextSessionScheduleRevisions(
  previous: ReadonlyMap<string, SessionScheduleRevision>,
  publication: {
    readonly version: number;
    readonly publishedAt: string;
    readonly agenda: AgendaDraft;
  },
): ReadonlyMap<string, SessionScheduleRevision> {
  const placed = placedSessionTimes(publication.agenda);
  const revisions = new Map<string, SessionScheduleRevision>();
  for (const [sessionId, schedule] of placed) {
    const held = previous.get(sessionId);
    const unchanged =
      held &&
      held.startsAt === schedule.startsAt &&
      held.endsAt === schedule.endsAt &&
      held.location === schedule.location;
    revisions.set(
      sessionId,
      unchanged
        ? held
        : {
            ...schedule,
            revision: publication.version,
            revisedAt: publication.publishedAt,
          },
    );
  }
  return revisions;
}

/**
 * What the agenda tells the rest of the system when a schedule becomes public.
 *
 * The agenda owns this payload, not whoever eventually delivers it: the facts it carries —
 * which event, which immutable publication, when, and how much of a programme it froze — are
 * only knowable here, and a consumer that had to re-derive them would be reading
 * `agenda_publications` behind this domain's back.
 *
 * `version` is the *event contract's* version and is 1; `publicationVersion` is the numbered
 * snapshot the publication allocated. Keeping the two apart is what lets the payload's shape
 * change one day without a consumer mistaking a v2 event for a second publication.
 *
 * `id` is derived from the publication rather than random, because the outbox record must be
 * idempotent under a retried command: two attempts at the same publication are the same event,
 * and a consumer that sees it twice must be able to tell.
 */
export interface SchedulePublishedEvent {
  readonly type: "EVT-SCHEDULE-PUBLISHED";
  readonly version: 1;
  readonly id: string;
  readonly eventId: string;
  readonly publicationVersion: number;
  readonly publishedAt: string;
  readonly placementCount: number;
}

/**
 * The event a committed publication emits.
 *
 * Derived wholly from the publication, so the same publication always produces the same event —
 * including its `id`. That determinism is the idempotency contract: a retried publish command
 * that lands on the same version emits a record a consumer can recognise as one it has seen.
 */
export function schedulePublishedEvent(publication: {
  readonly eventId: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly agenda: AgendaDraft;
}): SchedulePublishedEvent {
  return {
    type: "EVT-SCHEDULE-PUBLISHED",
    version: 1,
    id: `EVT-SCHEDULE-PUBLISHED:${publication.eventId}:${publication.version}`,
    eventId: publication.eventId,
    publicationVersion: publication.version,
    publishedAt: publication.publishedAt,
    placementCount: publication.agenda.placements.length,
  };
}

const overlaps = (left: AgendaSlot, right: AgendaSlot) =>
  Date.parse(left.startsAt) < Date.parse(right.endsAt) &&
  Date.parse(right.startsAt) < Date.parse(left.endsAt);

export function conflictsFor(draft: AgendaDraft): readonly AgendaConflict[] {
  const slots = new Map(draft.slots.map((slot) => [slot.id, slot]));
  const sessions = new Map(draft.sessions.map((session) => [session.id, session]));
  const conflicts: AgendaConflict[] = [];
  for (const placement of draft.placements)
    if (!sessions.has(placement.sessionId))
      conflicts.push({
        kind: "MISSING_SESSION",
        placementId: placement.id,
        conflictingPlacementId: placement.id,
        resourceId: placement.sessionId,
        message: "This session is no longer schedulable; remove its placement.",
      });
  for (let leftIndex = 0; leftIndex < draft.placements.length; leftIndex += 1) {
    const left = draft.placements[leftIndex];
    if (!left) continue;
    const leftSlot = slots.get(left.slotId);
    const leftSession = sessions.get(left.sessionId);
    if (!leftSlot || !leftSession) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < draft.placements.length; rightIndex += 1) {
      const right = draft.placements[rightIndex];
      if (!right) continue;
      const rightSlot = slots.get(right.slotId);
      const rightSession = sessions.get(right.sessionId);
      if (!rightSlot || !rightSession || !overlaps(leftSlot, rightSlot)) continue;
      const add = (kind: ConflictKind, resourceId: string, message: string) => {
        conflicts.push({
          kind,
          placementId: left.id,
          conflictingPlacementId: right.id,
          resourceId,
          message,
        });
      };
      if (left.roomId === right.roomId)
        add("ROOM_OVERLAP", left.roomId, "Move one session to a different room or time.");
      if (left.sessionId === right.sessionId)
        add("SESSION_OVERLAP", left.sessionId, "A session can only be placed once at a time.");
      for (const sharedSpeaker of leftSession.speakerIds.filter((id) =>
        rightSession.speakerIds.includes(id),
      ))
        add("SPEAKER_OVERLAP", sharedSpeaker, "Move one session so the speaker has no overlap.");
    }
  }
  return conflicts;
}
