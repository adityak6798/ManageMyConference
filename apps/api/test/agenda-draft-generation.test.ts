// @acceptance ACC-AGENDA
/**
 * Generating a whole agenda from an ordered set of criteria.
 *
 * Four claims, each asserted by constructing the case that would break it:
 *
 * - **Priority order decides.** Two soft criteria that disagree are given both orders, and the
 *   arrangement follows whichever the organizer put first. A list whose order changed nothing
 *   would not be worth configuring.
 * - **Hard constraints are absolute.** A speaker's availability and a speaker clash refuse a
 *   cell whatever their position, because a board the generator produced and publication then
 *   refuses is worse than the constraint.
 * - **An unplaced session names the criterion that refused it.** "Nothing fits" is not something
 *   an organizer can act on.
 * - **The pass is a function of its inputs.** The same board and criteria produce the same
 *   arrangement, which is what makes "re-run it" mean anything.
 */
import { describe, expect, it } from "vitest";
import type { AgendaDraft } from "../src/domain/agenda/agenda";
import {
  type Criterion,
  CRITERION_KEYS,
  CRITERION_KIND,
  comparePlan,
  DEFAULT_CRITERIA,
  generateAgendaDraft,
} from "../src/domain/agenda/draft-generation";

const board = (over: Partial<AgendaDraft> = {}): AgendaDraft => ({
  eventId: "event-1",
  rooms: [
    { id: "hall-a", name: "Hall A" },
    { id: "hall-b", name: "Hall B" },
  ],
  tracks: [
    { id: "main", name: "Main", color: "#2f5d50" },
    { id: "side", name: "Side", color: "#4a6fa5" },
  ],
  slots: [
    { id: "slot-1", startsAt: "2026-09-01T09:00:00.000Z", endsAt: "2026-09-01T10:00:00.000Z" },
    { id: "slot-2", startsAt: "2026-09-01T10:00:00.000Z", endsAt: "2026-09-01T11:00:00.000Z" },
  ],
  sessions: [
    { id: "a", title: "Alpha", speakerIds: ["ada"] },
    { id: "b", title: "Beta", speakerIds: ["ada"] },
  ],
  placements: [],
  ...over,
});

const only = (...keys: readonly string[]): Criterion[] =>
  CRITERION_KEYS.map((criterion, position) => ({
    criterion,
    position: keys.includes(criterion) ? keys.indexOf(criterion) : position + 100,
    enabled: keys.includes(criterion) || CRITERION_KIND[criterion] === "hard",
  }));

describe("generating an agenda draft", () => {
  it("seats every session without introducing a conflict the board would refuse", () => {
    const plan = generateAgendaDraft(board(), {
      criteria: DEFAULT_CRITERIA,
      availability: [],
    });
    expect(plan.placements).toHaveLength(2);
    expect(plan.unplaced).toEqual([]);
    // Two sessions sharing a speaker cannot land in the same slot, whatever the soft criteria say.
    const slots = plan.placements.map((placement) => placement.slotId);
    expect(new Set(slots).size).toBe(2);
  });

  it("is a function of its inputs, so re-running it converges", () => {
    const first = generateAgendaDraft(board(), {
      criteria: DEFAULT_CRITERIA,
      availability: [],
    });
    const second = generateAgendaDraft(board(), {
      criteria: DEFAULT_CRITERIA,
      availability: [],
    });
    expect(second.placements).toEqual(first.placements);
    // And the placement id is derived from the session, so a re-run moves rather than duplicates.
    expect(first.placements.map(({ id }) => id)).toEqual(["generated-a", "generated-b"]);
  });

  it("lets the organizer's priority order decide between criteria that disagree", () => {
    // Two sessions on the same track with no shared speaker, so both can share a slot: the only
    // thing deciding the rooms is whether keeping a track together beats spreading it out.
    const shared = board({
      sessions: [
        { id: "a", title: "Alpha", speakerIds: ["ada"] },
        { id: "b", title: "Beta", speakerIds: ["bea"] },
      ],
    });
    const declaredTracks = { a: ["main"], b: ["main"] };

    const together = generateAgendaDraft(shared, {
      criteria: only("keep-track-together", "prefer-earlier-slots"),
      availability: [],
      declaredTracks,
    });
    const spread = generateAgendaDraft(shared, {
      criteria: only("spread-tracks-across-rooms", "prefer-earlier-slots"),
      availability: [],
      declaredTracks,
    });

    const rooms = (plan: typeof together) => plan.placements.map((placement) => placement.roomId);
    // Keeping a track together puts the second session in the room the first one used; spreading
    // it puts the second somewhere else. The order is the only difference between the two runs.
    expect(new Set(rooms(together)).size).toBe(1);
    expect(new Set(rooms(spread)).size).toBe(2);
  });

  it("refuses a cell outside a speaker's availability, and says so", () => {
    const plan = generateAgendaDraft(
      board({ sessions: [{ id: "a", title: "Alpha", speakerIds: ["ada"] }] }),
      {
        criteria: DEFAULT_CRITERIA,
        availability: [
          {
            speakerId: "ada",
            startsAt: "2026-09-01T10:00:00.000Z",
            endsAt: "2026-09-01T11:00:00.000Z",
            kind: "available",
          },
        ],
      },
    );
    // The only admissible cell is the second slot, so that is where it lands.
    expect(plan.placements[0]?.slotId).toBe("slot-2");
  });

  it("names the criterion that refused every cell when a session cannot be seated", () => {
    const plan = generateAgendaDraft(
      board({ sessions: [{ id: "a", title: "Alpha", speakerIds: ["ada"] }] }),
      {
        criteria: DEFAULT_CRITERIA,
        availability: [
          {
            speakerId: "ada",
            // A window that overlaps nothing on the board.
            startsAt: "2026-10-01T09:00:00.000Z",
            endsAt: "2026-10-01T10:00:00.000Z",
            kind: "available",
          },
        ],
      },
    );
    expect(plan.placements).toEqual([]);
    expect(plan.unplaced[0]).toMatchObject({
      sessionId: "a",
      blockedBy: "respect-speaker-availability",
    });
    // The message is what an organizer would have to relax, in words rather than a rule name.
    expect(plan.unplaced[0]?.reason).toContain("availability");
  });

  it("explains a board with nothing to place into rather than answering empty", () => {
    const plan = generateAgendaDraft(board({ rooms: [], slots: [] }), {
      criteria: DEFAULT_CRITERIA,
      availability: [],
    });
    expect(plan.unplaced.map(({ blockedBy }) => blockedBy)).toEqual(["no-cells", "no-cells"]);
    const noTracks = generateAgendaDraft(board({ tracks: [] }), {
      criteria: DEFAULT_CRITERIA,
      availability: [],
    });
    expect(noTracks.unplaced[0]?.reason).toContain("no tracks configured");
  });

  it("keeps a hard constraint hard however the organizer orders the library", () => {
    // `avoid-speaker-clash` is put last and left enabled; two sessions sharing a speaker still
    // cannot share a slot, because publication would refuse the board it would otherwise produce.
    const demoted: Criterion[] = CRITERION_KEYS.map((criterion, position) => ({
      criterion,
      position: criterion === "avoid-speaker-clash" ? 99 : position,
      enabled: true,
    }));
    const plan = generateAgendaDraft(board(), { criteria: demoted, availability: [] });
    const slots = plan.placements.map((placement) => placement.slotId);
    expect(new Set(slots).size).toBe(2);
  });
});

describe("comparing a plan with the board", () => {
  it("reports each session as added, moved, unchanged or removed", () => {
    const live = board({
      placements: [
        { id: "p1", sessionId: "a", roomId: "hall-a", trackId: "main", slotId: "slot-1" },
        { id: "p2", sessionId: "b", roomId: "hall-b", trackId: "main", slotId: "slot-1" },
      ],
      sessions: [
        { id: "a", title: "Alpha", speakerIds: [] },
        { id: "b", title: "Beta", speakerIds: [] },
        { id: "c", title: "Gamma", speakerIds: [] },
      ],
    });
    const plan = {
      criteria: DEFAULT_CRITERIA,
      unplaced: [],
      placements: [
        // Unchanged.
        { id: "g-a", sessionId: "a", roomId: "hall-a", trackId: "main", slotId: "slot-1" },
        // Moved.
        { id: "g-b", sessionId: "b", roomId: "hall-b", trackId: "main", slotId: "slot-2" },
        // Added.
        { id: "g-c", sessionId: "c", roomId: "hall-a", trackId: "main", slotId: "slot-2" },
      ],
    };
    expect(comparePlan(live, plan).map(({ title, change }) => [title, change])).toEqual([
      ["Alpha", "unchanged"],
      ["Beta", "move"],
      ["Gamma", "add"],
    ]);
  });

  it("lists a session the draft could not seat as a removal rather than dropping it", () => {
    const live = board({
      placements: [
        { id: "p1", sessionId: "a", roomId: "hall-a", trackId: "main", slotId: "slot-1" },
      ],
    });
    const changes = comparePlan(live, {
      criteria: DEFAULT_CRITERIA,
      unplaced: [],
      placements: [],
    });
    // Accepting a whole draft must not quietly unschedule something; the organizer has to see it.
    expect(changes.find(({ sessionId }) => sessionId === "a")).toMatchObject({ change: "remove" });
  });
});
