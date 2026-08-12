// @spec PRD-AGD-001
/*
 * Assisted placement: a first draft of the board, not a decision about it.
 *
 * The organizer presses one button and gets every unscheduled session put somewhere that does
 * not clash. What comes out is ordinary draft state — the same placements a drag would have
 * produced, with the same ids and the same shape — so every existing action keeps working on
 * it and the explicit publish step is still the only thing that makes it public.
 *
 * There is exactly one notion of "conflict" in this domain and it is `conflictsFor`. This
 * module does not carry a second one: a candidate placement is accepted when adding it to the
 * board introduces no conflict *naming that placement*, which is the same test the board shows
 * the organizer and the same test publication refuses on. A rule invented here would be a rule
 * the conflict panel could not explain.
 */
import { conflictsFor, type AgendaDraft, type ConflictKind, type Placement } from "./agenda";

/** A session the pass could not seat, and the reason in the organizer's terms. */
export interface UnplacedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly reason: string;
}

export interface AssistedPlacementPlan {
  /** Placements to add, in the order they were chosen. */
  readonly placements: readonly Placement[];
  readonly unplaced: readonly UnplacedSession[];
}

/**
 * The placement id assisted placement gives a session.
 *
 * Derived from the session rather than generated, which is what makes a second run converge:
 * re-running the action moves a session's assisted placement instead of adding a duplicate
 * beside it. A session the organizer has since placed by hand is not unscheduled and is never
 * revisited, so a manual decision is never overwritten by a later press of the button.
 */
export const assistedPlacementId = (sessionId: string) => `assisted-${sessionId}`;

/** How each conflict kind reads when it is the reason a session could not be seated. */
const BLOCKED_BY: Record<ConflictKind, string> = {
  SPEAKER_OVERLAP: "double-book a speaker",
  ROOM_OVERLAP: "double-book a room",
  SESSION_OVERLAP: "place this session twice",
  MISSING_SESSION: "hold a session that no longer exists",
};

/**
 * Every (room, time) the board offers, in the order candidates are tried.
 *
 * Earliest slot first, and within a slot the rooms in the order the organizer configured them,
 * so the same board always yields the same plan. Slots are compared as instants — the stored
 * order is not meaningful — and ties break on id so the sort is total rather than merely
 * consistent within one engine's sort.
 */
function cellsInOrder(draft: AgendaDraft) {
  const slots = [...draft.slots].sort((left, right) => {
    const delta = Date.parse(left.startsAt) - Date.parse(right.startsAt);
    return delta || left.id.localeCompare(right.id);
  });
  return slots.flatMap((slot) => draft.rooms.map((room) => ({ slotId: slot.id, roomId: room.id })));
}

/**
 * Which track a session should land on.
 *
 * The session's own declared track when the organizer has configured one by that name, because
 * a generated draft that files every talk under one heading is not the useful starting point
 * the action promises. Otherwise the first configured track: a placement must name a track that
 * exists, and inventing one would put a value on the board the organizer never created.
 */
function trackFor(draft: AgendaDraft, declared: readonly string[] | undefined): string | null {
  for (const track of declared ?? []) if (draft.tracks.some(({ id }) => id === track)) return track;
  const names = new Set((declared ?? []).map((track) => track.toLowerCase()));
  const byName = draft.tracks.find(({ name }) => names.has(name.toLowerCase()));
  return byName?.id ?? draft.tracks[0]?.id ?? null;
}

/**
 * Seat every requested unscheduled session, first fit, without introducing a conflict.
 *
 * Deterministic in the draft and the request: sessions are considered by title then id, cells
 * in time-then-configured-room order, and the first cell that adds no conflict wins. Both
 * orders are total and computed here, so the same inputs always produce the same board — which
 * is what makes the result something an organizer can re-run and a test can assert on.
 *
 * Each candidate is checked against the placements accepted so far, not only against the board
 * as it arrived, so the pass cannot seat two sessions into the same room and hour or give one
 * speaker two rooms at once.
 */
export function planAssistedPlacements(
  draft: AgendaDraft,
  options: {
    /** Restrict to these sessions; omitted means every unscheduled session. */
    readonly sessionIds?: readonly string[] | undefined;
    /** Tracks each session declares, from the content domain. */
    readonly trackHints?: ReadonlyMap<string, readonly string[]> | undefined;
  } = {},
): AssistedPlacementPlan {
  const scheduled = new Set(draft.placements.map(({ sessionId }) => sessionId));
  const requested = options.sessionIds ? new Set(options.sessionIds) : null;
  /*
   * Ordered here rather than taken as given. Sessions arrive in the order the content domain
   * lists them, which is by title — meaningful, and what an organizer would expect to see
   * filled first — but two sessions sharing a title leave SQLite free to order them either
   * way. Determinism is this function's promise, so it does not rest on an upstream query
   * this domain does not own: title first to keep that intent, id to make the order total.
   */
  const candidates = draft.sessions
    .filter(({ id }) => !scheduled.has(id) && (!requested || requested.has(id)))
    .sort(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    );

  const cells = cellsInOrder(draft);
  const taken = new Set(draft.placements.map(({ roomId, slotId }) => `${roomId}~${slotId}`));
  const placements: Placement[] = [];
  const unplaced: UnplacedSession[] = [];
  // Grows as placements are accepted, so each candidate is tested against the board it would
  // actually join rather than the one this pass started from.
  let working = draft;

  for (const session of candidates) {
    const trackId = trackFor(draft, options.trackHints?.get(session.id));
    if (!trackId) {
      unplaced.push({
        sessionId: session.id,
        title: session.title,
        reason: "Add at least one track before generating a draft.",
      });
      continue;
    }
    const blockedBy = new Set<ConflictKind>();
    let seated = false;
    for (const cell of cells) {
      if (taken.has(`${cell.roomId}~${cell.slotId}`)) continue;
      const placement: Placement = {
        id: assistedPlacementId(session.id),
        sessionId: session.id,
        roomId: cell.roomId,
        trackId,
        slotId: cell.slotId,
      };
      const trial = { ...working, placements: [...working.placements, placement] };
      const introduced = conflictsFor(trial).filter(
        (conflict) =>
          conflict.placementId === placement.id || conflict.conflictingPlacementId === placement.id,
      );
      if (introduced.length) {
        for (const conflict of introduced) blockedBy.add(conflict.kind);
        continue;
      }
      placements.push(placement);
      taken.add(`${cell.roomId}~${cell.slotId}`);
      working = trial;
      seated = true;
      break;
    }
    if (seated) continue;
    unplaced.push({
      sessionId: session.id,
      title: session.title,
      reason: reasonFor(cells.length, taken.size, blockedBy),
    });
  }

  return { placements, unplaced };
}

/**
 * Why a session stayed unscheduled, in terms the board already uses.
 *
 * The three cases are genuinely different actions for the organizer: configure the board, make
 * room on it, or resolve a clash. Saying only "could not place" would leave them guessing which.
 */
function reasonFor(cellCount: number, takenCount: number, blockedBy: ReadonlySet<ConflictKind>) {
  if (!cellCount) return "Add at least one room and one time slot before generating a draft.";
  if (takenCount >= cellCount) return "Every room and time slot is already taken.";
  if (!blockedBy.size) return "No free room and time slot works for this session.";
  const reasons = [...blockedBy].map((kind) => BLOCKED_BY[kind]).sort();
  return `Every free room and time would ${reasons.join(" or ")}.`;
}
