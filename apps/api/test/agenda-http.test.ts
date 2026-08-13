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
import type { AgendaDraft } from "../src/domain/agenda/agenda";
import { createHttpAppFrom } from "../src/transport/http/app";

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
      agenda: {
        placements: unknown[];
        conflicts: unknown[];
        placed: string[];
        unplaced: unknown[];
      };
    };
    expect(agenda.placements).toHaveLength(2);
    // The route reports what the pass seated, not only the board it produced: a client cannot
    // separate this action's work from a concurrent one by comparing boards.
    expect([...agenda.placed].sort()).toEqual(["session-1", "session-2"]);
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

/**
 * The organizer's own answer to "is this event's stored schedule sound", and its repair.
 *
 * Issue #169's on-demand half. Neither route is the primary defence — reads re-derive a drifted
 * answer before serving it, and the one-minute tick sweeps the events nobody reads — so what is
 * asserted here is the two things only these can do: report without acting, and act on request.
 */
describe("schedule reconciliation route", () => {
  const reconciliationPath = `/api/events/${eventId}/agenda/schedule-reconciliation`;

  const drifted = async () => {
    const repository = new MemoryAgendaRepository([board]);
    const published = {
      eventId,
      version: 1,
      publishedAt: "2026-08-11T10:00:00.000Z",
      publishedBy: "organizer",
      agenda: {
        ...board,
        placements: [
          {
            id: "placement-1",
            sessionId: "session-1",
            roomId: "room-main",
            trackId: "track-web",
            slotId: "slot-9",
          },
        ],
      },
    };
    expect(await repository.publish(published)).toBe("committed");
    // The deploy window: a publication that unplaces the session, written by something that does
    // not maintain the derived table.
    await repository.recordUnmaintainedPublication({
      ...published,
      version: 2,
      publishedAt: "2026-08-12T10:00:00.000Z",
      agenda: board,
    });
    return createHttpAppFrom({
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
        repository,
        () => new Date("2026-08-11T10:00:00.000Z"),
        new FixtureSchedulableContentQuery(new Map([[eventId, board.sessions]])),
      ),
    });
  };

  const report = async (response: Response) =>
    (
      (await response.json()) as {
        reconciliation: {
          inSync: boolean;
          repaired: boolean;
          publications: number;
          publicationWatermark: number | null;
          materializedWatermark: number | null;
          drift: { missing: string[]; phantom: string[]; divergent: unknown[] };
        };
      }
    ).reconciliation;

  it("requires an organizer of the event", async () => {
    const app = await drifted();
    expect((await app.request(reconciliationPath)).status).toBe(401);
    expect(
      (await app.request(reconciliationPath, { headers: await cookie("speaker") })).status,
    ).toBe(403);
    expect(
      (await app.request(reconciliationPath, { method: "POST", headers: await cookie("speaker") }))
        .status,
    ).toBe(403);
  });

  it("reports the divergence without repairing it, then repairs it on request", async () => {
    const app = await drifted();
    const headers = await cookie("organizer");

    const first = await app.request(reconciliationPath, { headers });
    expect(first.status).toBe(200);
    const found = await report(first);
    expect(found).toMatchObject({
      inSync: false,
      repaired: false,
      publications: 2,
      publicationWatermark: 2,
      materializedWatermark: 1,
    });
    // A phantom row: the session the second publication unplaced still reads as scheduled, which
    // is what mails an invitation to a session the programme does not schedule.
    expect(found.drift.phantom).toEqual(["session-1"]);

    // Asking twice gives the same answer, because asking is not acting.
    expect(
      (await report(await app.request(reconciliationPath, { headers }))).drift.phantom,
    ).toEqual(["session-1"]);

    const repaired = await report(
      await app.request(reconciliationPath, { method: "POST", headers }),
    );
    expect(repaired).toMatchObject({ inSync: false, repaired: true, materializedWatermark: 2 });
    // `inSync` above describes what was found, not what was left behind — so the proof it worked
    // is the next read.
    const after = await report(await app.request(reconciliationPath, { headers }));
    expect(after).toMatchObject({ inSync: true, repaired: false, materializedWatermark: 2 });
    expect(after.drift).toEqual({ missing: [], phantom: [], divergent: [] });
  });

  it("refuses a malformed event id rather than replaying nothing", async () => {
    const app = await drifted();
    const response = await app.request("/api/events/not-a-uuid/agenda/schedule-reconciliation", {
      headers: await cookie("organizer"),
    });
    expect(response.status).toBe(400);
  });
});
