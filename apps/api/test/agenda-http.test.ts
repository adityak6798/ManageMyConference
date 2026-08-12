// @acceptance ACC-AGENDA
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpAppFrom } from "../src/transport/http/app";
import type { AgendaDraft } from "../src/domain/agenda/agenda";

const secret = "agenda-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const path = `/api/events/${eventId}/agenda/assisted-placements`;

const cookie = async (persona: "organizer" | "reviewer" | "speaker") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});

const board: AgendaDraft = {
  eventId,
  rooms: [{ id: "room-main", name: "Main stage" }],
  tracks: [{ id: "track-web", name: "Web", color: "#5b5bd6" }],
  slots: [
    { id: "slot-9", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
    { id: "slot-10", startsAt: "2026-09-01T17:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z" },
  ],
  sessions: [
    { id: "session-1", title: "One", speakerIds: ["speaker-1"] },
    { id: "session-2", title: "Two", speakerIds: ["speaker-2"] },
  ],
  placements: [],
};

const setup = () =>
  createHttpAppFrom({
    events: new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    agenda: new AgendaService(
      new MemoryAgendaRepository([board]),
      () => new Date("2026-08-11T10:00:00.000Z"),
      new FixtureSchedulableContentQuery(new Map([[eventId, board.sessions]])),
    ),
  });

describe("assisted placement route", () => {
  it("requires an organizer of the event", async () => {
    const app = setup();
    expect((await app.request(path, { method: "POST" })).status).toBe(401);
    expect(
      (await app.request(path, { method: "POST", headers: await cookie("speaker") })).status,
    ).toBe(403);
  });

  it("seats the unscheduled sessions and returns the draft", async () => {
    const response = await setup().request(path, {
      method: "POST",
      headers: await cookie("organizer"),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const { agenda } = (await response.json()) as {
      agenda: { placements: unknown[]; conflicts: unknown[]; unplaced: unknown[] };
    };
    expect(agenda.placements).toHaveLength(2);
    expect(agenda.conflicts).toEqual([]);
    expect(agenda.unplaced).toEqual([]);
  });

  it("accepts a request with no body at all", async () => {
    // The button sends `{}`, but "place everything" is the natural meaning of an empty POST
    // and a caller that omits the body should not get a validation error for it.
    const response = await setup().request(path, {
      method: "POST",
      headers: { cookie: (await cookie("organizer")).cookie },
    });

    expect(response.status).toBe(200);
  });

  it("returns the same publication for a retried command, and a new one without a key", async () => {
    const app = setup();
    const publish = (headers: Record<string, string>) =>
      app.request(`/api/events/${eventId}/agenda/publications`, { method: "POST", headers });
    const organizerHeaders = await cookie("organizer");

    const first = await publish({ ...organizerHeaders, "idempotency-key": "publish-1" });
    const retried = await publish({ ...organizerHeaders, "idempotency-key": "publish-1" });
    const fresh = await publish(organizerHeaders);

    const schedule = async (response: Response) =>
      ((await response.json()) as { schedule: { version: number; commandKey?: string } }).schedule;
    const [firstSchedule, retriedSchedule, freshSchedule] = [
      await schedule(first),
      await schedule(retried),
      await schedule(fresh),
    ];

    expect(firstSchedule.version).toBe(1);
    // One intent retried is one publication, not two immutable versions of the same board.
    expect(retriedSchedule.version).toBe(1);
    // No key means a new intent, which still gets its own version.
    expect(freshSchedule.version).toBe(2);
    // The key is stored, not echoed.
    expect(firstSchedule).not.toHaveProperty("commandKey");
  });

  it("refuses a session the event does not have", async () => {
    const response = await setup().request(path, {
      method: "POST",
      headers: await cookie("organizer"),
      body: JSON.stringify({ sessionIds: ["session-elsewhere"] }),
    });

    expect(response.status).toBe(404);
  });
});
