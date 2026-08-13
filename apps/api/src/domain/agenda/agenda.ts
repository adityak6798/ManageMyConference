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
  /**
   * The board revision at which *this* clash began.
   *
   * Two conflicts with the same kind and the same pair of placements are the same clash while
   * this is unchanged, and different clashes once it moves. A consumer that stores a decision
   * about a conflict — the operational inbox stores a dismissal — needs that distinction, because
   * a clash resolved on Tuesday and reintroduced on Thursday is news even though it is described
   * by the same three identifiers (issue #180). Derived from `AgendaDraft.occurrences`; `0` on a
   * board that has not moved since it was created.
   */
  readonly occurrence: number;
}

/**
 * When each part of the board last changed, by board revision.
 *
 * The board revision itself is monotonic and advances on every draft write, so it answers "has
 * anything moved" — but only this answers "has *this* moved", which is what a consumer keying a
 * stored decision on a derived condition needs. Keying on the board revision instead would drop
 * every dismissal on the programme the moment any card was dragged.
 *
 * Maintained forward on each write by `advanceBoardOccurrences`, the same shape as the
 * publication-time fold `nextSessionScheduleRevisions` and for the same reason: a value the
 * repository maintains beside the thing it describes cannot disagree with it, while one derived
 * on read from a history has to re-read that history on every request.
 */
export interface BoardOccurrences {
  /**
   * Session id → the revision at which that session's set of placements last changed.
   *
   * "Changed" means placed, unplaced, or moved to a different room, track or slot. A session that
   * has never been placed is absent, which reads as `0`: nothing has happened to it yet.
   */
  readonly sessions: Readonly<Record<string, number>>;
  /**
   * The revision at which the time slots last changed.
   *
   * The slots and nothing else, because they are the only resource a derived condition depends
   * on: `conflictsFor` decides an overlap from slot *times* and from ids that live on the
   * placements themselves, and reads neither the room list nor the tracks. Counting every
   * resource edit here would have been the safer-looking choice and a worse one — adding a
   * second room would have resurfaced every dismissed conflict on the event, which is exactly
   * the "a dismissal survives an edit to a different part of the programme" promise this pair of
   * numbers exists to keep. A slot removed or retimed can genuinely end a clash and bring it
   * back with both placements untouched, and that is what this covers.
   */
  readonly slots: number;
}

export const EMPTY_BOARD_OCCURRENCES: BoardOccurrences = { sessions: {}, slots: 0 };

export interface AgendaDraft {
  readonly eventId: string;
  readonly rooms: readonly AgendaRoom[];
  readonly tracks: readonly AgendaTrack[];
  readonly slots: readonly AgendaSlot[];
  readonly sessions: readonly SchedulableSession[];
  readonly placements: readonly Placement[];
  /**
   * Optional because a board stored before this existed has none, and because a snapshot must
   * not carry one: a publication is a frozen programme, not a record of how its draft was edited.
   */
  readonly occurrences?: BoardOccurrences | undefined;
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
 * hour is still true. Where one session holds two placements the last in array order wins, and
 * that branch *is* reachable in published history: `conflictsFor` raises `SESSION_OVERLAP` only
 * once the two placements' slots overlap in time, so a session placed twice at two separate
 * hours publishes without conflict. An earlier version of this comment claimed publication
 * blocked it; migration `1601` reproduces the ordering precisely because it does not.
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

/** Every cell one session occupies, in a form two boards can be compared by. */
function placedCells(draft: Pick<AgendaDraft, "placements">): ReadonlyMap<string, string> {
  const cells = new Map<string, string[]>();
  for (const placement of draft.placements)
    cells.set(placement.sessionId, [
      ...(cells.get(placement.sessionId) ?? []),
      `${placement.roomId}|${placement.trackId}|${placement.slotId}`,
    ]);
  // Sorted, so two placements of one session compare equal however the array happens to be
  // ordered — the repositories rebuild `placements` by filtering and appending, which reorders it.
  return new Map([...cells].map(([sessionId, list]) => [sessionId, list.toSorted().join(",")]));
}

const sameSlots = (left: AgendaDraft, right: AgendaDraft) =>
  JSON.stringify(left.slots) === JSON.stringify(right.slots);

/**
 * The occurrences one board write produces, given the ones in force before it.
 *
 * Called by the repository inside the write that changes the board, so the numbers are advanced
 * exactly once per revision and cannot drift from the board they describe.
 *
 * Three rules, each of which a derived condition depends on:
 *
 * *A session whose placements changed takes this revision.* Placed, unplaced, or moved to a
 * different cell — all three end the condition somebody may have dismissed and begin a new one.
 *
 * *A session nothing happened to keeps the number it had*, including one that is not on this
 * board at all. Carrying it forward is what makes the number an occurrence rather than a
 * timestamp of the last edit anywhere: dismissing an unplaced session and then dragging an
 * unrelated card must not resurrect the dismissed item.
 *
 * *The slots carry their own number*, because a clash can be resolved by retiming a slot rather
 * than by moving either placement — and reintroduced the same way, with both placements'
 * occurrences untouched. Rooms and tracks are deliberately not counted: no derived condition
 * reads them, so an edit to either would resurface dismissals about conditions it cannot affect.
 *
 * An entry survives the session that owned it: the fold sees placements, not the content domain's
 * session list, so it cannot tell "deleted" from "not placed here". That leaves at most one small
 * entry per session ever placed, which is bounded by the size of the programme.
 */
export function advanceBoardOccurrences(
  previous: AgendaDraft,
  next: AgendaDraft,
  revision: number,
): BoardOccurrences {
  const before = placedCells(previous);
  const after = placedCells(next);
  const held = previous.occurrences ?? EMPTY_BOARD_OCCURRENCES;
  const sessions: Record<string, number> = { ...held.sessions };
  for (const [sessionId, cells] of after)
    if (before.get(sessionId) !== cells) sessions[sessionId] = revision;
  for (const sessionId of before.keys()) if (!after.has(sessionId)) sessions[sessionId] = revision;
  return {
    sessions,
    slots: sameSlots(previous, next) ? held.slots : revision,
  };
}

const overlaps = (left: AgendaSlot, right: AgendaSlot) =>
  Date.parse(left.startsAt) < Date.parse(right.endsAt) &&
  Date.parse(right.startsAt) < Date.parse(left.endsAt);

export function conflictsFor(draft: AgendaDraft): readonly AgendaConflict[] {
  const slots = new Map(draft.slots.map((slot) => [slot.id, slot]));
  const sessions = new Map(draft.sessions.map((session) => [session.id, session]));
  const occurrences = draft.occurrences ?? EMPTY_BOARD_OCCURRENCES;
  const placedAt = (sessionId: string) => occurrences.sessions[sessionId] ?? 0;
  const conflicts: AgendaConflict[] = [];
  for (const placement of draft.placements)
    if (!sessions.has(placement.sessionId))
      conflicts.push({
        kind: "MISSING_SESSION",
        placementId: placement.id,
        conflictingPlacementId: placement.id,
        resourceId: placement.sessionId,
        message: "This session is no longer schedulable; remove its placement.",
        /*
         * The slots are left out: which times exist has nothing to do with whether the session
         * behind a placement is still schedulable, so retiming one is not a new occurrence of
         * this. What this number also does not follow is the transition that creates and clears
         * the condition — a session leaving and returning to the content domain — because that
         * happens outside the board entirely. It is unreachable in practice: withdrawing a
         * session unschedules its placements first, and a session recreated afterwards carries a
         * new id, so no key survives to be reused.
         */
        occurrence: placedAt(placement.sessionId),
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
      /*
       * A clash between two placements begins at the latest of the three things that can start
       * it: either placement arriving in the cell it now holds, or a slot being retimed under
       * both. Taking the maximum is what makes the occurrence advance whichever of them was the
       * edit that reintroduced the clash.
       */
      const occurrence = Math.max(
        placedAt(left.sessionId),
        placedAt(right.sessionId),
        occurrences.slots,
      );
      const add = (kind: ConflictKind, resourceId: string, message: string) => {
        conflicts.push({
          kind,
          placementId: left.id,
          conflictingPlacementId: right.id,
          resourceId,
          message,
          occurrence,
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
