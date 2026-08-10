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

const overlaps = (left: AgendaSlot, right: AgendaSlot) =>
  left.startsAt < right.endsAt && right.startsAt < left.endsAt;

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
