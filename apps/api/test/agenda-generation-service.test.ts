// @acceptance ACC-AGENDA
/**
 * Generating, comparing and accepting — the lifecycle around the generator.
 *
 * Three properties are the whole point of separating a generated draft from the board, and each
 * is asserted by constructing the case that would break it:
 *
 * - **Generating writes nothing to the board.** If it did, "generate three arrangements and
 *   compare them" would be impossible, which is what the existing assisted-placement action
 *   already suffers from.
 * - **Accepting applies only the sessions named.** Per-change acceptance is the unit the epic
 *   asks for, and a session left out has to keep whatever the board says about it.
 * - **A moved board is reported, not merged.** The draft records the revision it was generated
 *   against, and both the comparison and the accept notice when that has changed.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgendaDraft, Placement } from "../src/domain/agenda/agenda";
import {
  AgendaGenerationService,
  type GeneratedDraft,
  GeneratedDraftInvalidError,
  GeneratedDraftStaleError,
  type GenerationRepository,
} from "../src/application/agenda/generation-service";
import type { Actor, Capability } from "../src/application/identity/actor";

const EVENT = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-08-14T09:00:00.000Z");

const organizer: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: "00000000-0000-4000-8000-0000000000a0" }],
  eventAccess: [
    { eventId: EVENT, role: "organizer", capabilities: new Set<Capability>(["agenda:manage"]) },
  ],
  capabilities: new Set<Capability>(["agenda:manage"]),
};

const boardOf = (placements: readonly Placement[] = []): AgendaDraft => ({
  eventId: EVENT,
  rooms: [
    { id: "hall-a", name: "Hall A" },
    { id: "hall-b", name: "Hall B" },
  ],
  tracks: [{ id: "main", name: "Main", color: "#2f5d50" }],
  slots: [
    { id: "slot-1", startsAt: "2026-09-01T09:00:00.000Z", endsAt: "2026-09-01T10:00:00.000Z" },
    { id: "slot-2", startsAt: "2026-09-01T10:00:00.000Z", endsAt: "2026-09-01T11:00:00.000Z" },
  ],
  sessions: [
    { id: "a", title: "Alpha", speakerIds: ["ada"] },
    { id: "b", title: "Beta", speakerIds: ["bea"] },
  ],
  placements,
});

function harness(over: { board?: AgendaDraft; revision?: number; saveFails?: boolean } = {}) {
  let board = over.board ?? boardOf();
  const revision = over.revision ?? 4;
  const drafts = new Map<string, GeneratedDraft>();
  let nextId = 0;
  const savePlacements = vi.fn(
    async (_eventId: string, plan: (draft: AgendaDraft) => readonly Placement[]) => {
      const chosen = plan(board);
      if (over.saveFails) return null;
      board = { ...board, placements: [...board.placements, ...chosen] };
      return board;
    },
  );
  const removePlacement = vi.fn(async (_eventId: string, placementId: string) => {
    board = {
      ...board,
      placements: board.placements.filter((placement) => placement.id !== placementId),
    };
  });

  const repository: GenerationRepository = {
    listDrafts: async () => [...drafts.values()],
    findDraft: async (_eventId, draftId) => drafts.get(draftId) ?? null,
    createDraft: async (draft) => {
      drafts.set(draft.id, draft);
    },
    setDraftStatus: async (_eventId, draftId, status, at) => {
      const held = drafts.get(draftId);
      if (!held) return 0;
      drafts.set(draftId, { ...held, status, acceptedAt: status === "accepted" ? at : null });
      return 1;
    },
    listCriteria: async () => null,
    replaceCriteria: async () => undefined,
    listAvailability: async () => [],
    replaceAvailability: async () => undefined,
  };

  const service = new AgendaGenerationService({
    repository,
    board: {
      getDraft: async () => board,
      boardRevision: async () => revision,
      savePlacements,
      removePlacement,
    },
    newId: () => `00000000-0000-4000-8000-0000000000b${nextId++}`,
    now: () => NOW,
  });
  return { service, savePlacements, removePlacement, boardNow: () => board, drafts };
}

describe("generating a draft", () => {
  it("writes nothing to the board", async () => {
    const { service, savePlacements, removePlacement, boardNow } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    expect(draft.placements).toHaveLength(2);
    // The whole reason a generated draft is separate from the board.
    expect(savePlacements).not.toHaveBeenCalled();
    expect(removePlacement).not.toHaveBeenCalled();
    expect(boardNow().placements).toEqual([]);
    // And it records what it was generated against, so staleness is answerable later.
    expect(draft.boardRevision).toBe(4);
    expect(draft.status).toBe("proposed");
  });

  it("refuses a nameless draft rather than storing an unfindable one", async () => {
    const { service } = harness();
    await expect(service.generate(organizer, EVENT, "   ")).rejects.toThrow(
      GeneratedDraftInvalidError,
    );
  });

  it("defaults the criteria library and copies it into the draft", async () => {
    const { service } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    // Copied rather than referenced: reordering the library later must not re-explain this draft.
    expect(draft.criteria.map(({ criterion }) => criterion)).toContain("avoid-speaker-clash");
    expect(draft.criteria).toHaveLength(6);
  });
});

describe("comparing and accepting", () => {
  it("reports the board as stale once it has moved", async () => {
    const { service } = harness({ revision: 4 });
    const draft = await service.generate(organizer, EVENT, "First pass");
    const fresh = await service.compare(organizer, EVENT, draft.id);
    expect(fresh.stale).toBe(false);

    // A second service over the same drafts, reading a board that has since advanced.
    const moved = harness({ revision: 9 });
    await moved.service.generate(organizer, EVENT, "First pass");
    const [only] = [...moved.drafts.values()];
    const stored = only as GeneratedDraft;
    moved.drafts.set(stored.id, { ...stored, boardRevision: 4 });
    const comparison = await moved.service.compare(organizer, EVENT, stored.id);
    // Proposing placements into a board that has changed, without saying so, is the failure this
    // reports rather than the one it hides.
    expect(comparison.stale).toBe(true);
    expect(comparison.boardRevision).toBe(9);
  });

  it("applies only the sessions the organizer named", async () => {
    const { service, boardNow } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    const outcome = await service.accept(organizer, EVENT, draft.id, ["a"]);
    expect(outcome).toEqual({ applied: 1, unscheduled: 0 });
    expect(boardNow().placements.map(({ sessionId }) => sessionId)).toEqual(["a"]);
  });

  it("unschedules a session the organizer accepted that the draft could not seat", async () => {
    // The board holds Beta; the draft is doctored to omit it, which the comparison calls a
    // removal. Accepting that removal has to actually unschedule it rather than doing nothing.
    const seated: Placement = {
      id: "p-b",
      sessionId: "b",
      roomId: "hall-a",
      trackId: "main",
      slotId: "slot-1",
    };
    const { service, drafts, boardNow, removePlacement } = harness({
      board: boardOf([seated]),
    });
    const draft = await service.generate(organizer, EVENT, "First pass");
    drafts.set(draft.id, {
      ...draft,
      placements: draft.placements.filter((placement) => placement.sessionId !== "b"),
    });
    const outcome = await service.accept(organizer, EVENT, draft.id, ["b"]);
    expect(outcome.unscheduled).toBe(1);
    expect(removePlacement).toHaveBeenCalledWith(EVENT, "p-b");
    expect(boardNow().placements).toEqual([]);
  });

  it("drops a proposed placement whose slot has since disappeared, and says how many landed", async () => {
    const { service, drafts, savePlacements } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    drafts.set(draft.id, {
      ...draft,
      placements: draft.placements.map((placement) =>
        placement.sessionId === "a" ? { ...placement, slotId: "slot-that-went-away" } : placement,
      ),
    });
    const outcome = await service.accept(organizer, EVENT, draft.id, ["a", "b"]);
    // Re-derived inside the compare-and-set against the board being written, so a vanished slot
    // is dropped rather than written — and the organizer is told one of two landed.
    expect(outcome.applied).toBe(1);
    expect(savePlacements).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than merging when the board moved under the write", async () => {
    const { service } = harness({ saveFails: true });
    const draft = await service.generate(organizer, EVENT, "First pass");
    await expect(service.accept(organizer, EVENT, draft.id, ["a"])).rejects.toThrow(
      GeneratedDraftStaleError,
    );
  });

  it("keeps an accepted draft, so where an arrangement came from stays answerable", async () => {
    const { service, drafts } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    await service.accept(organizer, EVENT, draft.id, ["a"]);
    expect(drafts.get(draft.id)).toMatchObject({
      status: "accepted",
      acceptedAt: NOW.toISOString(),
    });
  });

  it("refuses to accept a discarded draft", async () => {
    const { service } = harness();
    const draft = await service.generate(organizer, EVENT, "First pass");
    await service.discard(organizer, EVENT, draft.id);
    await expect(service.accept(organizer, EVENT, draft.id, ["a"])).rejects.toThrow(
      GeneratedDraftInvalidError,
    );
  });
});

describe("the criteria library", () => {
  it("renumbers from the order supplied and keeps every criterion present", async () => {
    const { service } = harness();
    const saved = await service.setCriteria(organizer, EVENT, [
      { criterion: "prefer-earlier-slots" },
      { criterion: "keep-track-together", enabled: false },
    ]);
    expect(saved.slice(0, 2).map(({ criterion, position }) => [criterion, position])).toEqual([
      ["prefer-earlier-slots", 0],
      ["keep-track-together", 1],
    ]);
    // A library missing a criterion is a priority the generator would have to invent, so the
    // ones the caller left out keep their default order after the ones they named.
    expect(saved).toHaveLength(6);
    expect(saved.find(({ criterion }) => criterion === "keep-track-together")?.enabled).toBe(false);
  });

  it("refuses a criterion nothing implements", async () => {
    const { service } = harness();
    await expect(
      service.setCriteria(organizer, EVENT, [{ criterion: "put-the-good-ones-first" }]),
    ).rejects.toThrow(GeneratedDraftInvalidError);
  });

  it("refuses an availability window that ends before it starts", async () => {
    const { service } = harness();
    await expect(
      service.setAvailability(organizer, EVENT, [
        {
          speakerId: "ada",
          startsAt: "2026-09-02T09:00:00.000Z",
          endsAt: "2026-09-01T09:00:00.000Z",
          kind: "available",
        },
      ]),
    ).rejects.toThrow(GeneratedDraftInvalidError);
  });
});
