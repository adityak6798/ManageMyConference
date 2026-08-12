// @acceptance ACC-INTEGRATION ACC-SPEAKER
/*
 * The two new integration routes, over real HTTP.
 *
 * Everything else that covers these features stops short of the wire: the service tests call the
 * application directly and the component tests stub `fetch`. Neither would notice the failure that
 * actually strands a feature — a route registered under the wrong module, absent from the
 * registry, or reached with its service unwired. The demo runbook now tells an evaluator to press
 * these buttons, so "the button is connected to something" needs an assertion of its own.
 *
 * Composed through `createHttpAppFrom` with named services, so a service arriving in the wrong
 * slot is a type error rather than a silent 500.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryAccelEventsSyncRuns } from "../src/adapters/persistence/d1-accelevents-sync-runs";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { FixtureAccelEventsRegistrations } from "../src/adapters/providers/accelevents-registration";
import {
  AccelEventsSyncService,
  AccelEventsUnavailableError,
} from "../src/application/communications/public";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpAppFrom } from "../src/transport/http/app";

const secret = "integrations-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";

/** Content's import command, reduced to the contract the sync depends on. */
function contentDouble() {
  const imported = new Set<string>();
  return {
    imported,
    async importSpeakers(
      _actor: unknown,
      input: { eventId: string; csv: string; commit: boolean },
    ) {
      const [, ...lines] = input.csv.split("\n").filter(Boolean);
      return {
        rows: lines.map((line, index) => {
          const [name = "", email = ""] = line.split(",");
          const clean = email.replaceAll('"', "").trim().toLowerCase();
          const errors = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)
            ? []
            : ["Valid email is required"];
          const duplicate = imported.has(clean);
          if (input.commit && !errors.length && !duplicate) imported.add(clean);
          return { row: index + 2, name, email: clean, duplicate, errors };
        }),
      };
    },
  };
}

async function setup(options: { unreachable?: boolean } = {}) {
  const events = new EventService({
    repository: new MemoryEventRepository(),
    newId: () => "event-1",
    now: () => new Date("2026-08-12T09:00:00.000Z"),
  });
  const accelEventsSync = new AccelEventsSyncService({
    source: options.unreachable
      ? {
          listRegistrants: async () => {
            throw new AccelEventsUnavailableError("PROVIDER_UNAVAILABLE:503");
          },
        }
      : new FixtureAccelEventsRegistrations(),
    content: contentDouble(),
    runs: new MemoryAccelEventsSyncRuns(),
    mode: "fixture",
    now: () => new Date("2026-08-12T09:00:00.000Z"),
  });
  const app = createHttpAppFrom({
    events,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    accelEventsSync,
  });
  const session = async (persona: "organizer" | "speaker") => ({
    cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
    "content-type": "application/json",
  });
  return { app, session };
}

const sync = (
  app: Awaited<ReturnType<typeof setup>>["app"],
  headers: Record<string, string>,
  commit: boolean,
) =>
  app.request(`/api/events/${eventId}/integrations/accelevents/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({ commit }),
  });

describe("the Accelevents integration over HTTP", () => {
  it("describes the integration and runs a dry sync for an organizer", async () => {
    const { app, session } = await setup();
    const headers = await session("organizer");

    const described = await app.request(`/api/events/${eventId}/integrations/accelevents`, {
      headers,
    });
    expect(described.status).toBe(200);
    // `mode` reaching the client is what stops a fixture count being read as a live one.
    await expect(described.json()).resolves.toEqual({
      mode: "fixture",
      direction: "inbound",
      lastRun: null,
    });

    const preview = await sync(app, headers, false);
    expect(preview.status).toBe(200);
    const report = await preview.json();
    expect(report).toMatchObject({ preview: true, total: 4, created: 3, invalid: 1 });
    // The last run is still absent: a dry run changed nothing, so it claims nothing.
    const after = await (
      await app.request(`/api/events/${eventId}/integrations/accelevents`, { headers })
    ).json();
    expect(after.lastRun).toBeNull();
  });

  it("records the applied run where the organizer surface reads it", async () => {
    const { app, session } = await setup();
    const headers = await session("organizer");

    expect((await sync(app, headers, true)).status).toBe(200);

    const described = await (
      await app.request(`/api/events/${eventId}/integrations/accelevents`, { headers })
    ).json();
    expect(described.lastRun).toMatchObject({ outcome: "succeeded", created: 3, invalid: 1 });
  });

  it("answers 502 rather than 500 when the registration platform cannot be read", async () => {
    const { app, session } = await setup({ unreachable: true });
    const headers = await session("organizer");

    const response = await sync(app, headers, false);
    // Not our bug and not the caller's mistake: reporting it as either sends an organizer to the
    // wrong place. The normalized code travels; the upstream's own message never does.
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.error.message).toContain("PROVIDER_UNAVAILABLE:503");
  });

  it("refuses a speaker and an anonymous caller before reading anything", async () => {
    const { app, session } = await setup();
    const speaker = await session("speaker");

    expect((await sync(app, speaker, false)).status).toBe(403);
    expect(
      (await app.request(`/api/events/${eventId}/integrations/accelevents`, { headers: speaker }))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/events/${eventId}/integrations/accelevents/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commit: true }),
        })
      ).status,
    ).toBe(401);
  });

  it("rejects a malformed event id and a body that does not say what to do", async () => {
    const { app, session } = await setup();
    const headers = await session("organizer");

    expect(
      (
        await app.request("/api/events/not-a-uuid/integrations/accelevents/sync", {
          method: "POST",
          headers,
          body: JSON.stringify({ commit: true }),
        })
      ).status,
    ).toBe(400);
    // `commit` is the difference between a preview and a write, so it is required rather than
    // defaulted: a caller that omits it must not get an apply by accident.
    expect(
      (
        await app.request(`/api/events/${eventId}/integrations/accelevents/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);
  });
});
