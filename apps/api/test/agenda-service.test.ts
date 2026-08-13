// @acceptance ACC-AGENDA
import { agendaAssistedDraftSchema } from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import {
  AgendaConflictError,
  AgendaPublicationConflictError,
  AgendaService,
} from "../src/application/agenda/agenda-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import type { Actor } from "../src/application/identity/actor";
import { type AgendaDraft, conflictsFor } from "../src/domain/agenda/agenda";
import { planAssistedPlacements } from "../src/domain/agenda/assisted-placement";

const eventId = "00000000-0000-4000-8000-000000000001";
const draft: AgendaDraft = {
  eventId,
  rooms: [
    { id: "room-main", name: "Main stage" },
    { id: "room-lab", name: "Lab" },
  ],
  tracks: [{ id: "track-web", name: "Web", color: "#5b5bd6" }],
  slots: [
    { id: "slot-9", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
    { id: "slot-930", startsAt: "2026-09-01T16:30:00.000Z", endsAt: "2026-09-01T17:30:00.000Z" },
  ],
  sessions: [
    { id: "session-a", title: "Opening", speakerIds: ["speaker-1"] },
    { id: "session-b", title: "Deep dive", speakerIds: ["speaker-1"] },
  ],
  placements: [
    {
      id: "place-a",
      sessionId: "session-a",
      roomId: "room-main",
      trackId: "track-web",
      slotId: "slot-9",
    },
    {
      id: "place-b",
      sessionId: "session-b",
      roomId: "room-main",
      trackId: "track-web",
      slotId: "slot-930",
    },
  ],
};
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: "org" }],
  capabilities: new Set(["agenda:manage"]),
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["agenda:manage"]) }],
};
const content = new FixtureSchedulableContentQuery(new Map([[eventId, draft.sessions]]));

/**
 * A board with room for four sessions and four to seat, two of which share a speaker. The
 * shared speaker is the point: a pass that only avoided double-booking rooms would seat them
 * in the same hour and produce a draft the organizer cannot publish.
 */
const emptyBoard: AgendaDraft = {
  eventId,
  rooms: [
    { id: "room-main", name: "Main stage" },
    { id: "room-lab", name: "Lab" },
  ],
  tracks: [
    { id: "track-web", name: "Web", color: "#5b5bd6" },
    { id: "track-ops", name: "Ops", color: "#16866b" },
  ],
  slots: [
    { id: "slot-9", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
    { id: "slot-10", startsAt: "2026-09-01T17:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z" },
  ],
  sessions: [
    { id: "session-1", title: "One", speakerIds: ["speaker-1"] },
    { id: "session-2", title: "Two", speakerIds: ["speaker-1"] },
    { id: "session-3", title: "Three", speakerIds: ["speaker-2"] },
    { id: "session-4", title: "Four", speakerIds: ["speaker-3"] },
  ],
  placements: [],
};

describe("assisted agenda placement", () => {
  const boardContent = () =>
    new FixtureSchedulableContentQuery(new Map([[eventId, emptyBoard.sessions]]));

  it("seats every unscheduled session in one draft read, one content read, and one write", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const getDraft = vi.spyOn(repository, "getDraft");
    const savePlacements = vi.spyOn(repository, "savePlacements");
    const savePlacement = vi.spyOn(repository, "savePlacement");
    const schedulable = boardContent();
    const listSessions = vi.spyOn(schedulable, "listSchedulableSessions");
    const service = new AgendaService(repository, () => new Date(), schedulable);

    const result = await service.autoPlace(organizer, eventId);

    // Four sessions cost exactly what one drag costs. Looping `place` would have made this
    // four reads and four writes, which is the per-placement cost issue #69 removed.
    expect(getDraft).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(savePlacements).toHaveBeenCalledTimes(1);
    expect(savePlacement).not.toHaveBeenCalled();
    expect(result.placements).toHaveLength(4);
    expect(result.unplaced).toEqual([]);
  });

  /*
   * The half of the contract the board could not reach until issue #119.
   *
   * `sessionIds` has been accepted since the action shipped, but nothing asserted that naming a
   * subset seats *only* it — the route test covers the refusal for an unknown session and the
   * cost is asserted for the whole board. Both halves matter now that an organizer can tick two
   * of five sessions and press the button.
   */
  it("seats only the sessions it was given, at the same cost as the whole board", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const getDraft = vi.spyOn(repository, "getDraft");
    const savePlacements = vi.spyOn(repository, "savePlacements");
    const service = new AgendaService(repository, () => new Date(), boardContent());

    const result = await service.autoPlace(organizer, eventId, ["session-2", "session-4"]);

    expect(result.placements.map(({ sessionId }) => sessionId).sort()).toEqual([
      "session-2",
      "session-4",
    ]);
    // What the pass seated, said by the only party that can know it: the board it returns also
    // carries whatever else landed while the request was in flight, so a caller diffing boards
    // cannot tell this pass's work from another organizer's.
    expect([...result.placed].sort()).toEqual(["session-2", "session-4"]);
    // The two it was not asked about are left where they were, not reported as unplaceable:
    // they were never candidates, and an explanation would be about a pass that never ran.
    expect(result.unplaced).toEqual([]);
    // One read and one write for a subset, exactly as for the whole board (issue #119): a
    // selection must not reintroduce the per-placement round trip issue #69 removed.
    expect(getDraft).toHaveBeenCalledTimes(1);
    expect(savePlacements).toHaveBeenCalledTimes(1);
    expect(result.conflicts).toEqual([]);
  });

  /*
   * The one path where "what this pass seated" can disagree with what exists.
   *
   * `savePlacements` takes a planner the repository may run more than once: it plans against the
   * revision it is about to replace, so a lost compare-and-set re-plans, and the attempt that
   * lost the race planned placements that were never written. Both implementations write the
   * whole plan or none of it, so reading `placed` off the stored board is defence rather than a
   * bug fix — but it is the difference between a number that follows from what exists and one
   * that follows from an attempt, and only the first stays true if that ever changes.
   *
   * The double below drives that shape directly: the planner runs twice and the write keeps one
   * placement. It does not reproduce D1's compare-and-set itself, which belongs to the
   * repository's own integration test.
   */
  it("reports only the placements the write kept, when the planner runs more than once", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const real = repository.savePlacements.bind(repository);
    vi.spyOn(repository, "savePlacements").mockImplementation(async (id, plan) =>
      real(id, (current) => {
        // A first run whose plan is thrown away, as a lost compare-and-set discards one.
        plan(current);
        // The run that counts, of which the write keeps only the first placement.
        const [first] = plan(current);
        return first ? [first] : [];
      }),
    );
    const service = new AgendaService(repository, () => new Date(), boardContent());

    const result = await service.autoPlace(organizer, eventId);

    expect(result.placed).toHaveLength(1);
    expect(result.placements).toHaveLength(1);
    // Said about the stored board, not about an attempt: every id reported is on it.
    const stored = new Set(result.placements.map(({ sessionId }) => sessionId));
    expect(result.placed.every((sessionId) => stored.has(sessionId))).toBe(true);
  });

  it("produces a conflict-free board, keeping a shared speaker out of one hour", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const service = new AgendaService(repository, () => new Date(), boardContent());

    const result = await service.autoPlace(organizer, eventId);

    // The board's own conflict rule is the judge, not a second one written for this test.
    expect(result.conflicts).toEqual([]);
    const slotOf = (sessionId: string) =>
      result.placements.find((placement) => placement.sessionId === sessionId)?.slotId;
    expect(slotOf("session-1")).not.toEqual(slotOf("session-2"));
  });

  it("gives the same board every time for the same inputs", async () => {
    const run = async () => {
      const service = new AgendaService(
        new MemoryAgendaRepository([emptyBoard]),
        () => new Date(),
        boardContent(),
      );
      const { placements } = await service.autoPlace(organizer, eventId);
      return placements.map(({ sessionId, roomId, slotId, trackId }) => ({
        sessionId,
        roomId,
        slotId,
        trackId,
      }));
    };

    expect(await run()).toEqual(await run());
  });

  it("orders sessions itself, so a tie in the content query cannot change the board", async () => {
    // Two sessions share a title, which is what the content query orders by — SQLite is then
    // free to return them either way round. The plan must not depend on which way it did.
    const tied = [
      { id: "session-b", title: "Same name", speakerIds: [] },
      { id: "session-a", title: "Same name", speakerIds: [] },
      { id: "session-c", title: "Another", speakerIds: [] },
    ];
    const planFor = (sessions: typeof tied) =>
      planAssistedPlacements({ ...emptyBoard, sessions }).placements.map(
        ({ sessionId, roomId, slotId }) => ({ sessionId, roomId, slotId }),
      );

    expect(planFor(tied)).toEqual(planFor([...tied].reverse()));
    // And the tie breaks on id, so the board is predictable rather than merely stable.
    expect(planFor(tied)[0]?.sessionId).toBe("session-c");
  });

  it("leaves what it cannot seat unscheduled, and says why", async () => {
    // One room, one slot, two sessions: the second has nowhere to go.
    const cramped: AgendaDraft = {
      ...emptyBoard,
      rooms: [{ id: "room-main", name: "Main stage" }],
      slots: [emptyBoard.slots[0] as AgendaDraft["slots"][number]],
      sessions: emptyBoard.sessions.slice(0, 2),
    };
    const service = new AgendaService(
      new MemoryAgendaRepository([cramped]),
      () => new Date(),
      new FixtureSchedulableContentQuery(new Map([[eventId, cramped.sessions]])),
    );

    const result = await service.autoPlace(organizer, eventId);

    expect(result.placements).toHaveLength(1);
    expect(result.unplaced).toEqual([
      {
        sessionId: "session-2",
        title: "Two",
        reason: "Every room and time slot is already taken.",
      },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("never moves a session the organizer placed by hand", async () => {
    const held: AgendaDraft = {
      ...emptyBoard,
      placements: [
        {
          id: "manual",
          sessionId: "session-1",
          roomId: "room-lab",
          trackId: "track-ops",
          slotId: "slot-10",
        },
      ],
    };
    const service = new AgendaService(
      new MemoryAgendaRepository([held]),
      () => new Date(),
      boardContent(),
    );

    const result = await service.autoPlace(organizer, eventId);

    expect(result.placements).toContainEqual(expect.objectContaining({ id: "manual" }));
    expect(result.placements.filter(({ sessionId }) => sessionId === "session-1")).toHaveLength(1);
  });

  it("generates draft state only, publishing nothing", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const service = new AgendaService(repository, () => new Date(), boardContent());

    await service.autoPlace(organizer, eventId);

    expect(await service.published(eventId)).toBeNull();
  });

  it("re-running converges instead of duplicating placements", async () => {
    const repository = new MemoryAgendaRepository([emptyBoard]);
    const service = new AgendaService(repository, () => new Date(), boardContent());

    await service.autoPlace(organizer, eventId);
    const second = await service.autoPlace(organizer, eventId);

    // Everything is seated after the first pass, so the second has nothing to do and the
    // board still holds one placement per session.
    expect(second.placements).toHaveLength(4);
    expect(second.conflicts).toEqual([]);
  });
});

describe("board occurrences", () => {
  /*
   * The agenda-owned half of `GAP-022` (issue #180). What is being pinned is not a number but a
   * distinction: "this session is still unplaced" against "this session was placed and taken off
   * again", which the board's own identifiers cannot express because they are reused exactly.
   * Everything downstream — the operational inbox's dismissal key — is built on it.
   */
  const boardless: AgendaDraft = { ...draft, placements: [] };
  const service = (repository: MemoryAgendaRepository) =>
    new AgendaService(repository, () => new Date(), content);

  it("advances a session's occurrence when it is placed, moved and unplaced, and nothing else's", async () => {
    const repository = new MemoryAgendaRepository([boardless]);
    const agenda = service(repository);
    const place = (id: string, sessionId: string, slotId: string) =>
      agenda.place(organizer, eventId, {
        id,
        sessionId,
        roomId: "room-main",
        trackId: "track-web",
        slotId,
      });

    const first = await place("place-a", "session-a", "slot-9");
    expect(first.occurrences?.sessions["session-a"]).toBe(1);
    // Session B has never been on the board: absent, which every reader takes as 0.
    expect(first.occurrences?.sessions["session-b"]).toBeUndefined();

    const moved = await place("place-a", "session-a", "slot-930");
    expect(moved.occurrences?.sessions["session-a"]).toBe(2);

    // Somebody else's placement, which must not disturb A's number — the whole reason this is
    // per session rather than the board revision that advances on every edit.
    const other = await place("place-b", "session-b", "slot-9");
    expect(other.occurrences?.sessions["session-a"]).toBe(2);
    expect(other.occurrences?.sessions["session-b"]).toBe(3);

    await agenda.remove(organizer, eventId, "place-a");
    const after = await agenda.draft(organizer, eventId);
    // Taken off the board: strictly higher than the number the placement had, which is what makes
    // the unplaced condition a new one rather than the one somebody dismissed before.
    expect(after.occurrences?.sessions["session-a"]).toBe(4);
  });

  it("re-placing in the same cell is still a new occurrence, because the absence was one", async () => {
    const repository = new MemoryAgendaRepository([boardless]);
    const agenda = service(repository);
    const cell = {
      id: "place-a",
      sessionId: "session-a",
      roomId: "room-main",
      trackId: "track-web",
      slotId: "slot-9",
    };

    await agenda.place(organizer, eventId, cell);
    await agenda.remove(organizer, eventId, "place-a");
    const back = await agenda.place(organizer, eventId, cell);

    expect(back.occurrences?.sessions["session-a"]).toBe(3);
  });

  it("gives a conflict the later of the two placements' occurrences, and moves it with the slots", async () => {
    const repository = new MemoryAgendaRepository([boardless]);
    const agenda = service(repository);
    const clashing = { roomId: "room-main", trackId: "track-web", slotId: "slot-9" };
    await agenda.place(organizer, eventId, { id: "place-a", sessionId: "session-a", ...clashing });
    const clash = await agenda.place(organizer, eventId, {
      id: "place-b",
      sessionId: "session-b",
      ...clashing,
    });

    // Two sessions in one room at one hour, and a shared speaker besides.
    expect(clash.conflicts.map(({ kind, occurrence }) => ({ kind, occurrence }))).toEqual([
      { kind: "ROOM_OVERLAP", occurrence: 2 },
      { kind: "SPEAKER_OVERLAP", occurrence: 2 },
    ]);

    /*
     * The negatives, and each asserts the list is still there before asserting about it: `every`
     * is true of an empty array, so a `configure` that quietly dropped the whole board would have
     * satisfied the earlier form of these three lines — and the whole suite besides. A review pass
     * proved exactly that by mutation.
     *
     * Adding a room, adding a time slot nothing is placed in, and retiming a slot neither
     * placement is in are all edits to a different part of the programme. No derived condition
     * reads the room list — an overlap is decided by the room *ids* the placements already carry
     * — and a slot no placement references cannot change any pair's overlap however it moves.
     */
    const widened = await agenda.configure(organizer, eventId, {
      rooms: [...draft.rooms, { id: "room-annex", name: "Annex" }],
      tracks: draft.tracks,
      slots: [
        ...draft.slots,
        { id: "slot-11", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T19:00:00.000Z" },
      ],
    });
    expect(widened.conflicts).toHaveLength(2);
    expect(widened.conflicts.every(({ occurrence }) => occurrence === 2)).toBe(true);

    const elsewhere = await agenda.configure(organizer, eventId, {
      rooms: widened.rooms,
      tracks: draft.tracks,
      slots: widened.slots.map((slot) =>
        slot.id === "slot-11" ? { ...slot, endsAt: "2026-09-01T20:00:00.000Z" } : slot,
      ),
    });
    expect(elsewhere.conflicts).toHaveLength(2);
    expect(elsewhere.conflicts.every(({ occurrence }) => occurrence === 2)).toBe(true);

    // Re-spelling the same instant is not a retiming either: the schema accepts both spellings and
    // `conflictsFor` reads them through `Date.parse`, so a client that normalizes its own payload
    // must not look like an organizer who moved the hour.
    const respelled = await agenda.configure(organizer, eventId, {
      rooms: widened.rooms,
      tracks: draft.tracks,
      slots: elsewhere.slots.map((slot) =>
        slot.id === "slot-9" ? { ...slot, startsAt: "2026-09-01T16:00:00Z" } : slot,
      ),
    });
    expect(respelled.conflicts).toHaveLength(2);
    expect(respelled.conflicts.every(({ occurrence }) => occurrence === 2)).toBe(true);

    // Retiming the slot the placements are actually in is the other way this clash can be
    // resolved and reintroduced, so that — and only that — advances a slot's own number.
    const retimed = await agenda.configure(organizer, eventId, {
      rooms: widened.rooms,
      tracks: draft.tracks,
      slots: respelled.slots.map((slot) =>
        slot.id === "slot-9" ? { ...slot, endsAt: "2026-09-01T16:20:00.000Z" } : slot,
      ),
    });
    expect(retimed.conflicts).toHaveLength(2);
    expect(retimed.conflicts.every(({ occurrence }) => occurrence === 6)).toBe(true);
  });

  it("keeps a slot's number where it is when the board sends the same slots in another order", async () => {
    // The console sorts slots by start before sending them, so a payload whose order differs from
    // storage is an ordinary request rather than a contrived one. Reordering is not a retiming.
    const repository = new MemoryAgendaRepository([boardless]);
    const agenda = service(repository);
    await agenda.place(organizer, eventId, {
      id: "place-a",
      sessionId: "session-a",
      roomId: "room-main",
      trackId: "track-web",
      slotId: "slot-9",
    });

    const reordered = await agenda.configure(organizer, eventId, {
      rooms: draft.rooms,
      tracks: draft.tracks,
      slots: [...draft.slots].toReversed(),
    });

    expect(reordered.slots.map(({ id }) => id)).toEqual(["slot-930", "slot-9"]);
    expect(reordered.occurrences?.slots).toEqual({});
  });

  it("answers a board stored before occurrences existed with them, including from the repository", async () => {
    /*
     * No migration backfilled them, so every board written before this commit — the seeded one
     * included — carries none, and the contract this change made required is not optional about
     * it. `savePlacements` is the one path that answers with a board it did not write: a plan
     * that seats nothing returns the board as read, which is the ordinary answer once every cell
     * is taken. That path served a draft with no `occurrences` and the console refused the
     * response rather than showing the explanation it was carrying.
     */
    const legacy: AgendaDraft = {
      ...draft,
      placements: [
        {
          id: "place-a",
          sessionId: "session-a",
          roomId: "room-main",
          trackId: "track-web",
          slotId: "slot-9",
        },
        {
          id: "place-b",
          sessionId: "session-b",
          roomId: "room-main",
          trackId: "track-web",
          slotId: "slot-930",
        },
      ],
    };
    expect(legacy).not.toHaveProperty("occurrences");
    const repository = new MemoryAgendaRepository([legacy]);
    const agenda = service(repository);

    // Both sessions are already placed, so the pass has nothing to seat and answers with the
    // board as it read it — the same branch a full board reaches when it cannot seat what is
    // left, and the one path that returns a draft neither write path normalized.
    const seated = await agenda.autoPlace(organizer, eventId);

    expect(seated.placed).toEqual([]);
    expect(seated.occurrences).toEqual({ sessions: {}, slots: {} });
    expect(agendaAssistedDraftSchema.safeParse(seated).success).toBe(true);
    // Asserted against the repository rather than against `draft()`, which normalizes on its own
    // account: reading it through the service would pass with the repository's guarantee removed.
    expect((await repository.getDraft(eventId))?.occurrences).toEqual({ sessions: {}, slots: {} });
  });

  it("keeps them out of the publication snapshot", async () => {
    const repository = new MemoryAgendaRepository([boardless]);
    const agenda = service(repository);
    await agenda.place(organizer, eventId, {
      id: "place-a",
      sessionId: "session-a",
      roomId: "room-main",
      trackId: "track-web",
      slotId: "slot-9",
    });

    const published = await agenda.publish(organizer, eventId);

    // A snapshot is a frozen programme, not a record of how its draft was edited — and two
    // publications of one board should be identical bytes whatever happened in between.
    expect(published.agenda).not.toHaveProperty("occurrences");
    expect(published.agenda).not.toHaveProperty("conflicts");
  });
});

describe("published session schedule revisions", () => {
  const publication = (version: number, agenda: AgendaDraft) => ({
    eventId,
    version,
    publishedAt: `2026-08-12T00:00:0${version}.000Z`,
    publishedBy: "organizer",
    agenda,
  });

  it("changes only when that session moves or returns after being absent", async () => {
    const withoutA = {
      ...draft,
      placements: draft.placements.filter(({ sessionId }) => sessionId !== "session-a"),
    };
    const movedB = {
      ...draft,
      placements: draft.placements.map((placement) =>
        placement.sessionId === "session-b" ? { ...placement, roomId: "room-lab" } : placement,
      ),
    };
    const repository = new MemoryAgendaRepository([], [publication(1, draft)]);
    await repository.publish(publication(2, draft));
    await repository.publish(publication(3, movedB));
    await repository.publish(publication(4, withoutA));
    await repository.publish(publication(5, draft));
    const schedules = await new AgendaService(
      repository,
      () => new Date(),
      content,
    ).publishedSessionSchedules(eventId);

    expect(schedules.get("session-a")?.revision).toBe(5);
    expect(schedules.get("session-b")?.revision).toBe(4);
  });

  const revisionsAfter = async (...history: readonly PublishedSchedule[]) => {
    const [seeded, ...rest] = history;
    const repository = new MemoryAgendaRepository([], seeded ? [seeded] : []);
    for (const publication of rest) await repository.publish(publication);
    return new AgendaService(repository, () => new Date(), content).publishedSessionSchedules(
      eventId,
    );
  };

  /**
   * The comparison is on the hour and the place, not on the ids that produced them. A board
   * rebuilt with new slot and placement ids — a common enough consequence of editing the
   * resource list — must not resend an invitation to every speaker on it.
   */
  it("does not advance when a session moves to a different slot at the same hour", async () => {
    const twin = {
      id: "slot-9-twin",
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    };
    const movedToTwin = {
      ...draft,
      slots: [...draft.slots, twin],
      placements: draft.placements.map((placement) =>
        placement.sessionId === "session-a"
          ? { ...placement, id: "place-a-twin", slotId: twin.id }
          : placement,
      ),
    };

    const schedules = await revisionsAfter(publication(1, draft), publication(2, movedToTwin));

    // A different slot and a different placement id, but the same instants in the same room.
    expect(schedules.get("session-a")).toEqual({
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
      location: "Main stage",
      revision: 1,
      revisedAt: "2026-08-12T00:00:01.000Z",
    });
  });

  /** A removed room is a changed location, and the hour it was booked for is still true. */
  it("keeps the hour and empties the location when the room leaves the snapshot", async () => {
    const withoutMainStage = {
      ...draft,
      rooms: draft.rooms.filter(({ id }) => id !== "room-main"),
    };

    const schedules = await revisionsAfter(publication(1, draft), publication(2, withoutMainStage));

    expect(schedules.get("session-a")).toEqual({
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
      location: "",
      revision: 2,
      revisedAt: "2026-08-12T00:00:02.000Z",
    });
  });

  /**
   * Absence resets even when nobody was watching during it.
   *
   * An empty board publishes every session out of the programme at once, so the identical
   * placement that follows is a genuinely new statement to a calendar client that dropped the
   * event. Carrying the old revision across the gap would suppress the REQUEST that puts it
   * back (issue #136).
   */
  it("treats a published empty board as an absence that resets the revision", async () => {
    const schedules = await revisionsAfter(
      publication(1, draft),
      publication(2, { ...draft, placements: [] }),
      publication(3, draft),
    );

    expect(schedules.get("session-a")?.revision).toBe(3);
    expect(schedules.get("session-b")?.revision).toBe(3);
  });
});

describe("agenda conflicts and publication", () => {
  it("places with one draft read, one schedulable-content read, and one write", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const getDraft = vi.spyOn(repository, "getDraft");
    const savePlacement = vi.spyOn(repository, "savePlacement");
    const schedulable = new FixtureSchedulableContentQuery(new Map([[eventId, draft.sessions]]));
    const listSessions = vi.spyOn(schedulable, "listSchedulableSessions");
    const service = new AgendaService(repository, () => new Date(), schedulable);

    const result = await service.place(organizer, eventId, {
      id: "place-c",
      sessionId: "session-a",
      roomId: "room-lab",
      trackId: "track-web",
      slotId: "slot-9",
    });

    expect(getDraft).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(savePlacement).toHaveBeenCalledTimes(1);
    expect(result.placements).toContainEqual(expect.objectContaining({ id: "place-c" }));
  });
  it("returns the post-CAS draft when another placement landed before the write", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const concurrent = {
      id: "place-concurrent",
      sessionId: "session-b",
      roomId: "room-lab",
      trackId: "track-web",
      slotId: "slot-930",
    };
    const original = repository.savePlacement.bind(repository);
    vi.spyOn(repository, "savePlacement").mockImplementation(async (id, placement) => {
      await original(id, concurrent);
      return original(id, placement);
    });
    const service = new AgendaService(repository, () => new Date(), content);

    const result = await service.place(organizer, eventId, {
      id: "place-c",
      sessionId: "session-a",
      roomId: "room-lab",
      trackId: "track-web",
      slotId: "slot-9",
    });

    expect(result.placements.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["place-concurrent", "place-c"]),
    );
  });
  it("reports every overlapping resource with a resolution", () => {
    expect(conflictsFor(draft)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ROOM_OVERLAP",
          resourceId: "room-main",
          message: expect.stringContaining("different room"),
        }),
        expect.objectContaining({
          kind: "SPEAKER_OVERLAP",
          resourceId: "speaker-1",
          message: expect.stringContaining("speaker"),
        }),
      ]),
    );
  });
  it("reports every shared speaker independently", () => {
    const sessions = draft.sessions.map((session) => ({
      ...session,
      speakerIds: ["speaker-1", "speaker-2"],
    }));
    expect(
      conflictsFor({ ...draft, sessions }).filter(({ kind }) => kind === "SPEAKER_OVERLAP"),
    ).toHaveLength(2);
  });
  it("initializes resources and protects resources used by placements", async () => {
    const repository = new MemoryAgendaRepository();
    const service = new AgendaService(repository, () => new Date(), content);
    expect(
      (
        await service.configure(organizer, eventId, {
          rooms: draft.rooms,
          tracks: draft.tracks,
          slots: draft.slots,
        })
      ).rooms,
    ).toEqual(draft.rooms);
    await repository.saveDraft(draft);
    await expect(
      service.configure(organizer, eventId, {
        rooms: [],
        tracks: draft.tracks,
        slots: draft.slots,
      }),
    ).rejects.toThrow("Remove affected placements");
  });
  it("blocks publication when content removes a placed session", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const removedContent = new FixtureSchedulableContentQuery(new Map([[eventId, []]]));
    const service = new AgendaService(repository, () => new Date(), removedContent);
    await expect(service.publish(organizer, eventId)).rejects.toMatchObject({
      conflicts: expect.arrayContaining([
        expect.objectContaining({ kind: "MISSING_SESSION", resourceId: "session-a" }),
      ]),
    });
  });
  it("allows adjacent slots without an overlap", () => {
    const [first, second] = draft.slots;
    if (!first || !second) throw new Error("Fixture slots are required");
    const adjacent = {
      ...draft,
      slots: [first, { ...second, startsAt: first.endsAt }],
    };
    expect(conflictsFor(adjacent)).toEqual([]);
  });
  it("compares instants across different ISO fractional precision", () => {
    const [first, second] = draft.slots;
    if (!first || !second) throw new Error("Fixture slots are required");
    const variant = {
      ...draft,
      slots: [
        { ...first, startsAt: "2026-09-01T16:00:00Z", endsAt: "2026-09-01T17:00:00Z" },
        { ...second, startsAt: "2026-09-01T16:00:00.500Z", endsAt: "2026-09-01T17:00:00.500Z" },
      ],
    };
    expect(conflictsFor(variant)).not.toEqual([]);
  });
  it("blocks conflicts, then publishes an immutable version without leaking later drafts", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-10T20:00:00.000Z"),
      content,
    );
    await expect(service.publish(organizer, eventId)).rejects.toBeInstanceOf(AgendaConflictError);
    await service.remove(organizer, eventId, "place-b");
    const published = await service.publish(organizer, eventId);
    expect(published).toMatchObject({ version: 1, publishedBy: "organizer" });
    expect(published.agenda).not.toHaveProperty("conflicts");
    const secondPlacement = draft.placements[1];
    if (!secondPlacement) throw new Error("Fixture placement is required");
    await service.place(organizer, eventId, {
      ...secondPlacement,
      roomId: "room-lab",
      slotId: "slot-9",
    });
    const publicSchedule = await service.published(eventId);
    expect(publicSchedule?.agenda.placements).toHaveLength(1);
    expect(publicSchedule).not.toHaveProperty("publishedBy");
    expect((await service.draft(organizer, eventId)).placements).toHaveLength(2);
  });
  it("emits exactly one event per committed publication, naming that publication", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-10T20:00:00.000Z"),
      content,
    );
    await service.remove(organizer, eventId, "place-b");

    const first = await service.publish(organizer, eventId);
    const second = await service.publish(organizer, eventId);

    // Republishing allocates the next version rather than reusing or overwriting one, and each
    // committed publication carries one event that identifies it.
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(repository.publishedEvents()).toEqual([
      expect.objectContaining({
        type: "EVT-SCHEDULE-PUBLISHED",
        version: 1,
        id: `EVT-SCHEDULE-PUBLISHED:${eventId}:1`,
        publicationVersion: 1,
      }),
      expect.objectContaining({
        id: `EVT-SCHEDULE-PUBLISHED:${eventId}:2`,
        publicationVersion: 2,
      }),
    ]);
  });
  it("answers a retried publish command with the publication it already made", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-10T20:00:00.000Z"),
      content,
    );
    await service.remove(organizer, eventId, "place-b");

    const first = await service.publish(organizer, eventId, "command-1");
    const retried = await service.publish(organizer, eventId, "command-1");

    // One intent, one immutable version, one event — however many times the client asked.
    expect(retried).toEqual(first);
    expect(repository.publishedEvents()).toHaveLength(1);

    // A *different* command is a new intent and still gets its own version.
    const deliberate = await service.publish(organizer, eventId, "command-2");
    expect(deliberate.version).toBe(2);
    expect(repository.publishedEvents()).toHaveLength(2);
  });

  it("replays a retried command even after the board has moved into conflict", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    const service = new AgendaService(
      repository,
      () => new Date("2026-08-10T20:00:00.000Z"),
      content,
    );
    await service.remove(organizer, eventId, "place-b");
    const first = await service.publish(organizer, eventId, "command-1");

    // Put the board into conflict after the publication this command already committed.
    const second = draft.placements[1];
    if (!second) throw new Error("Fixture placement is required");
    await service.place(organizer, eventId, { ...second, slotId: "slot-9" });

    // The retry describes work that already succeeded, so it must not be refused for a
    // conflict introduced afterwards.
    expect(await service.publish(organizer, eventId, "command-1")).toEqual(first);
  });

  it("gives up rather than looping when versions keep being taken", async () => {
    const repository = new MemoryAgendaRepository([draft]);
    // A repository that never commits stands in for sustained concurrent publication: the
    // allocation loop must end and say so, not spin until the request times out.
    vi.spyOn(repository, "publish").mockResolvedValue("version-taken");
    const service = new AgendaService(repository, () => new Date(), content);
    await service.remove(organizer, eventId, "place-b");

    await expect(service.publish(organizer, eventId)).rejects.toBeInstanceOf(
      AgendaPublicationConflictError,
    );
  });
  it("requires a freshly created event role before agenda initialization", async () => {
    const organizationOwner = { ...organizer, eventAccess: [] };
    const service = new AgendaService(
      new MemoryAgendaRepository(),
      () => new Date(),
      content,
      async () => true,
    );
    await expect(
      service.configure(organizationOwner, eventId, {
        rooms: draft.rooms,
        tracks: draft.tracks,
        slots: draft.slots,
      }),
    ).rejects.toThrow("Actor lacks agenda:manage for event");
  });
  it("does not treat read-only cross-tenant event access as ownership", async () => {
    const foreignEventId = "00000000-0000-4000-8000-000000000099";
    const organizationOwnerWithForeignRead = {
      ...organizer,
      eventAccess: [
        {
          eventId: foreignEventId,
          role: "reviewer" as const,
          capabilities: new Set(["events:read" as const]),
        },
      ],
    };
    const service = new AgendaService(
      new MemoryAgendaRepository(),
      () => new Date(),
      content,
      async (actor) => actor.organizations.some(({ id }) => id === "outside-organization"),
    );
    await expect(
      service.configure(organizationOwnerWithForeignRead, foreignEventId, {
        rooms: draft.rooms,
        tracks: draft.tracks,
        slots: draft.slots,
      }),
    ).rejects.toThrow("Actor lacks agenda:manage for event");
  });
  it("fails cross-event operations before mutation", async () => {
    const service = new AgendaService(
      new MemoryAgendaRepository([draft]),
      () => new Date(),
      content,
    );
    await expect(
      service.remove(organizer, "00000000-0000-4000-8000-000000000099", "place-a"),
    ).rejects.toThrow("Actor lacks agenda:manage for event");
  });
});
