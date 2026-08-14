/**
 * Generating a whole agenda from an ordered set of criteria, without touching the live board.
 *
 * Issue #192's residual agenda-generation epic. `assisted-placement.ts` already seats unscheduled
 * sessions by first fit; this is the other thing the epic asks for, and the differences are the
 * design:
 *
 * - **It proposes rather than writes.** The output is a candidate placement set. Nothing here
 *   knows how to save anything, which is what makes "compare, then accept the parts you want"
 *   expressible at all.
 * - **The rule is the organizer's, in their priority order.** A criterion earlier in the list
 *   outweighs every criterion after it, and hard constraints are absolute regardless of position.
 * - **A session it cannot seat says why, naming the criterion.** "Nothing fits" is not an
 *   explanation an organizer can act on; "every remaining cell would double-book Ada" is.
 *
 * **Hard and soft is the generator's decision, not the library's.** `avoid-speaker-clash` and
 * `respect-speaker-availability` refuse a cell; the rest score it. Letting an organizer demote a
 * hard constraint to a preference would let them generate a board the publication step then
 * refuses, which is a worse experience than the constraint.
 *
 * **Determinism is a property, not an accident.** Sessions are considered in a total order,
 * cells in a total order, and ties break on id — so the same board and the same criteria always
 * produce the same draft. That is what makes "re-run it" meaningful and what lets a test assert
 * on a whole arrangement rather than on a property of one.
 *
 * @spec PRD-AGD-001
 */
import { type AgendaDraft, type ConflictKind, conflictsFor, type Placement } from "./agenda";

export type CriterionKey =
  | "avoid-speaker-clash"
  | "respect-speaker-availability"
  | "keep-track-together"
  | "spread-tracks-across-rooms"
  | "prefer-earlier-slots"
  | "balance-room-load";

export const CRITERION_KEYS: readonly CriterionKey[] = [
  "avoid-speaker-clash",
  "respect-speaker-availability",
  "keep-track-together",
  "spread-tracks-across-rooms",
  "prefer-earlier-slots",
  "balance-room-load",
];

/** Whether a criterion refuses a cell or merely dislikes it. Fixed per key; see the header. */
export const CRITERION_KIND: Readonly<Record<CriterionKey, "hard" | "soft">> = {
  "avoid-speaker-clash": "hard",
  "respect-speaker-availability": "hard",
  "keep-track-together": "soft",
  "spread-tracks-across-rooms": "soft",
  "prefer-earlier-slots": "soft",
  "balance-room-load": "soft",
};

/** What each criterion is called when it is the reason a session could not be seated. */
export const CRITERION_LABEL: Readonly<Record<CriterionKey, string>> = {
  "avoid-speaker-clash": "would double-book a speaker",
  "respect-speaker-availability": "falls outside a speaker's availability",
  "keep-track-together": "keeps a track together",
  "spread-tracks-across-rooms": "spreads tracks across rooms",
  "prefer-earlier-slots": "prefers earlier slots",
  "balance-room-load": "balances how busy each room is",
};

export interface Criterion {
  readonly criterion: CriterionKey;
  readonly position: number;
  readonly enabled: boolean;
}

/** The library an event starts with: both hard rules on, and a sensible soft order after them. */
export const DEFAULT_CRITERIA: readonly Criterion[] = CRITERION_KEYS.map((criterion, position) => ({
  criterion,
  position,
  enabled: true,
}));

export interface AvailabilityWindow {
  readonly speakerId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: "available" | "unavailable";
}

/** A session the pass could not seat, and the criterion that refused every remaining cell. */
export interface UnplacedExplanation {
  readonly sessionId: string;
  readonly title: string;
  /** The criterion that refused the most cells, or `no-cells` when the board offers none. */
  readonly blockedBy: CriterionKey | "no-cells" | "board-conflict";
  readonly reason: string;
}

export interface GeneratedPlan {
  readonly placements: readonly Placement[];
  readonly unplaced: readonly UnplacedExplanation[];
  /** The criteria that produced it, in the order applied. Copied into the stored draft. */
  readonly criteria: readonly Criterion[];
}

/** The placement id a generated draft gives a session. Derived, so a re-run converges. */
export const generatedPlacementId = (sessionId: string) => `generated-${sessionId}`;

const BLOCKED_BY: Record<ConflictKind, string> = {
  SPEAKER_OVERLAP: "would double-book a speaker",
  ROOM_OVERLAP: "would double-book a room",
  SESSION_OVERLAP: "would place this session twice",
  MISSING_SESSION: "would hold a session that no longer exists",
};

/** Every (slot, room) the board offers, earliest first and then in configured room order. */
function cellsInOrder(draft: AgendaDraft) {
  const slots = [...draft.slots].sort((left, right) => {
    const delta = Date.parse(left.startsAt) - Date.parse(right.startsAt);
    return delta || left.id.localeCompare(right.id);
  });
  return slots.flatMap((slot, slotIndex) =>
    draft.rooms.map((room, roomIndex) => ({
      slotId: slot.id,
      roomId: room.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      slotIndex,
      roomIndex,
    })),
  );
}

type Cell = ReturnType<typeof cellsInOrder>[number];

/**
 * Does this speaker's availability admit this cell?
 *
 * `available` windows are a whitelist: once a speaker has one, every cell outside all of them is
 * refused. `unavailable` windows are a blacklist regardless. A speaker with neither is
 * unconstrained, which is what makes the feature opt-in per person rather than a form everybody
 * has to fill in before the generator works at all.
 */
function availabilityAdmits(
  windows: readonly AvailabilityWindow[],
  speakerId: string,
  cell: Cell,
): boolean {
  const mine = windows.filter((window) => window.speakerId === speakerId);
  if (mine.length === 0) return true;
  const overlaps = (window: AvailabilityWindow) =>
    Date.parse(cell.startsAt) < Date.parse(window.endsAt) &&
    Date.parse(window.startsAt) < Date.parse(cell.endsAt);
  if (mine.some((window) => window.kind === "unavailable" && overlaps(window))) return false;
  const allow = mine.filter((window) => window.kind === "available");
  return allow.length === 0 || allow.some(overlaps);
}

/**
 * Which track a session should land on.
 *
 * The same rule assisted placement uses, and for the same reason: a generated draft that files
 * every talk under one heading is not a useful starting point, and inventing a track would put a
 * value on the board the organizer never created.
 */
function trackFor(draft: AgendaDraft, declared: readonly string[] | undefined): string | null {
  for (const track of declared ?? []) if (draft.tracks.some(({ id }) => id === track)) return track;
  const names = new Set((declared ?? []).map((track) => track.toLowerCase()));
  const byName = draft.tracks.find(({ name }) => names.has(name.toLowerCase()));
  return byName?.id ?? draft.tracks[0]?.id ?? null;
}

/**
 * Score one candidate cell against the soft criteria, lower being better.
 *
 * Priority is expressed as a weight that falls off sharply with position, so a criterion earlier
 * in the organizer's list outweighs every combination of the ones after it. That is what "priority
 * order" has to mean to be worth configuring: a list where a later rule could outvote an earlier
 * one is a list whose order does not decide anything.
 */
function scoreCell(
  cell: Cell,
  input: {
    trackId: string | null;
    criteria: readonly Criterion[];
    placed: readonly Placement[];
    cells: readonly Cell[];
  },
): number {
  const soft = input.criteria.filter(
    (entry) => entry.enabled && CRITERION_KIND[entry.criterion] === "soft",
  );
  let score = 0;
  soft.forEach((entry, rank) => {
    // 100, 10, 1 … — each criterion outweighs everything after it, whatever their raw penalties.
    const weight = 10 ** (soft.length - rank - 1);
    score += weight * penaltyFor(entry.criterion, cell, input);
  });
  return score;
}

function penaltyFor(
  criterion: CriterionKey,
  cell: Cell,
  input: {
    trackId: string | null;
    placed: readonly Placement[];
    cells: readonly Cell[];
  },
): number {
  switch (criterion) {
    case "keep-track-together": {
      // Prefer a room this track is already using, so a delegate following one track walks less.
      if (!input.trackId) return 0;
      const roomsForTrack = new Set(
        input.placed
          .filter((placement) => placement.trackId === input.trackId)
          .map((placement) => placement.roomId),
      );
      return roomsForTrack.size === 0 || roomsForTrack.has(cell.roomId) ? 0 : 1;
    }
    case "spread-tracks-across-rooms": {
      // The exact opposite pull — prefer a room this track has *not* used yet — and both are
      // offered because conferences genuinely want either: one wants a delegate following a
      // track to stay put, the other wants a track visible all over the venue. The organizer's
      // order is what decides which wins when they disagree.
      if (!input.trackId) return 0;
      const roomsForTrack = new Set(
        input.placed
          .filter((placement) => placement.trackId === input.trackId)
          .map((placement) => placement.roomId),
      );
      return roomsForTrack.has(cell.roomId) ? 1 : 0;
    }
    case "prefer-earlier-slots":
      return cell.slotIndex;
    case "balance-room-load": {
      // How many sessions this room already holds, so the busiest room is chosen last.
      return input.placed.filter((placement) => placement.roomId === cell.roomId).length;
    }
    default:
      return 0;
  }
}

/**
 * Generate a whole board from the sessions, the criteria and the speakers' availability.
 *
 * Every session is placed from scratch — the live board's own placements are deliberately *not*
 * carried in, because the point of a generated draft is to be comparable with the board rather
 * than an increment on it. What the organizer keeps is decided when they accept, not here.
 *
 * A cell is rejected outright when a hard criterion refuses it or when adding the placement would
 * introduce a conflict naming it. That second test is `conflictsFor`, the domain's one notion of
 * conflict: a rule invented here would be a rule the board's own conflict panel could not explain.
 */
export function generateAgendaDraft(
  draft: AgendaDraft,
  input: {
    readonly criteria: readonly Criterion[];
    readonly availability: readonly AvailabilityWindow[];
    /** Each session's declared tracks, from content. Absent means "no preference". */
    readonly declaredTracks?: Readonly<Record<string, readonly string[]>> | undefined;
  },
): GeneratedPlan {
  const criteria = [...input.criteria].sort(
    (left, right) =>
      left.position - right.position || left.criterion.localeCompare(right.criterion),
  );
  const enabled = new Set(
    criteria.filter((entry) => entry.enabled).map((entry) => entry.criterion),
  );
  const cells = cellsInOrder(draft);
  const sessions = [...draft.sessions].sort(
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );

  const placements: Placement[] = [];
  const unplaced: UnplacedExplanation[] = [];

  for (const session of sessions) {
    const trackId = trackFor(draft, input.declaredTracks?.[session.id]);
    if (!trackId || cells.length === 0) {
      unplaced.push({
        sessionId: session.id,
        title: session.title,
        blockedBy: "no-cells",
        reason: !trackId
          ? "This event has no tracks configured, and a placement has to name one."
          : "This event has no rooms or time slots to place anything into.",
      });
      continue;
    }
    // Why each cell was refused, so the explanation can name the criterion that mattered most
    // rather than reporting the last failure to be encountered.
    const refusals = new Map<CriterionKey | "board-conflict", number>();
    const admissible: { cell: Cell; score: number }[] = [];
    for (const cell of cells) {
      if (enabled.has("respect-speaker-availability")) {
        const blocked = session.speakerIds.some(
          (speakerId) => !availabilityAdmits(input.availability, speakerId, cell),
        );
        if (blocked) {
          refusals.set(
            "respect-speaker-availability",
            (refusals.get("respect-speaker-availability") ?? 0) + 1,
          );
          continue;
        }
      }
      const candidate: Placement = {
        id: generatedPlacementId(session.id),
        sessionId: session.id,
        roomId: cell.roomId,
        trackId,
        slotId: cell.slotId,
      };
      const conflicts = conflictsFor({
        ...draft,
        // Only what this pass has placed: the live board's arrangement is what the draft is being
        // compared against, so carrying it in would make the generator agree with it by default.
        placements: [...placements, candidate],
      }).filter(
        (conflict) =>
          conflict.placementId === candidate.id || conflict.conflictingPlacementId === candidate.id,
      );
      if (conflicts.length > 0) {
        const speakerClash = conflicts.some((conflict) => conflict.kind === "SPEAKER_OVERLAP");
        const key: CriterionKey | "board-conflict" =
          speakerClash && enabled.has("avoid-speaker-clash")
            ? "avoid-speaker-clash"
            : "board-conflict";
        refusals.set(key, (refusals.get(key) ?? 0) + 1);
        continue;
      }
      admissible.push({
        cell,
        score: scoreCell(cell, { trackId, criteria, placed: placements, cells }),
      });
    }

    if (admissible.length === 0) {
      // The criterion that refused the most cells is the one worth naming: it is the constraint
      // an organizer would have to relax to make this session placeable.
      const [blockedBy] = [...refusals.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0] ?? ["no-cells" as const, 0];
      unplaced.push({
        sessionId: session.id,
        title: session.title,
        blockedBy,
        reason:
          blockedBy === "board-conflict"
            ? `Every remaining slot ${BLOCKED_BY.ROOM_OVERLAP}.`
            : blockedBy === "no-cells"
              ? "This event has no rooms or time slots to place anything into."
              : `Every remaining slot ${CRITERION_LABEL[blockedBy]}.`,
      });
      continue;
    }

    // Lowest score wins; ties break on the cell order, which is itself total. Both together make
    // the whole pass a function of its inputs.
    admissible.sort(
      (left, right) =>
        left.score - right.score ||
        left.cell.slotIndex - right.cell.slotIndex ||
        left.cell.roomIndex - right.cell.roomIndex,
    );
    const chosen = admissible[0] as { cell: Cell };
    placements.push({
      id: generatedPlacementId(session.id),
      sessionId: session.id,
      roomId: chosen.cell.roomId,
      trackId,
      slotId: chosen.cell.slotId,
    });
  }

  return { placements, unplaced, criteria };
}

/** One session's difference between the live board and a generated draft. */
export interface PlacementChange {
  readonly sessionId: string;
  readonly title: string;
  readonly change: "add" | "move" | "unchanged" | "remove";
  readonly current: { roomId: string; slotId: string; trackId: string } | null;
  readonly proposed: { roomId: string; slotId: string; trackId: string } | null;
}

/**
 * Compare a generated draft with the board it would replace, session by session.
 *
 * Session by session rather than placement by placement, because that is the unit an organizer
 * accepts or rejects: "move the keynote to Hall B" is a decision, and "delete placement
 * `generated-x` and add placement `assisted-y`" is the same decision spelled in a way nobody can
 * act on. `remove` is a session the board places and the draft does not — usually because the
 * draft could not seat it — and it is listed rather than silently dropped so accepting the whole
 * draft cannot quietly unschedule something.
 */
export function comparePlan(board: AgendaDraft, plan: GeneratedPlan): readonly PlacementChange[] {
  const titles = new Map(board.sessions.map((session) => [session.id, session.title]));
  const current = new Map(board.placements.map((placement) => [placement.sessionId, placement]));
  const proposed = new Map(plan.placements.map((placement) => [placement.sessionId, placement]));
  const at = (placement: Placement | undefined) =>
    placement
      ? { roomId: placement.roomId, slotId: placement.slotId, trackId: placement.trackId }
      : null;
  return [...new Set([...current.keys(), ...proposed.keys()])]
    .sort(
      (left, right) =>
        (titles.get(left) ?? left).localeCompare(titles.get(right) ?? right) ||
        left.localeCompare(right),
    )
    .map((sessionId) => {
      const before = at(current.get(sessionId));
      const after = at(proposed.get(sessionId));
      const change: PlacementChange["change"] = !before
        ? "add"
        : !after
          ? "remove"
          : before.roomId === after.roomId &&
              before.slotId === after.slotId &&
              before.trackId === after.trackId
            ? "unchanged"
            : "move";
      return {
        sessionId,
        title: titles.get(sessionId) ?? sessionId,
        change,
        current: before,
        proposed: after,
      };
    });
}
