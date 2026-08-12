// @acceptance ACC-AGENDA
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
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
   * revision it is about to replace, so a lost compare-and-set re-plans, and an attempt that
   * lost planned placements that were never written. Both implementations of the port write the
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
