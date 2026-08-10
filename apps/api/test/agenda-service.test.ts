// @acceptance ACC-AGENDA
import { describe, expect, it } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { AgendaConflictError, AgendaService } from "../src/application/agenda/agenda-service";
import type { Actor } from "../src/application/identity/actor";
import { conflictsFor, type AgendaDraft } from "../src/domain/agenda/agenda";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";

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

describe("agenda conflicts and publication", () => {
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
  it("fails cross-event operations before mutation", async () => {
    const service = new AgendaService(
      new MemoryAgendaRepository([draft]),
      () => new Date(),
      content,
    );
    await expect(
      service.remove(organizer, "00000000-0000-4000-8000-000000000099", "place-a"),
    ).rejects.toThrow("Agenda access denied");
  });
});
