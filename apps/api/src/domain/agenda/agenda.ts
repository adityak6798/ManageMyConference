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
