// @acceptance ACC-INTEGRATION
import { describe, expect, it, vi } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { CommunicationsService } from "../src/application/communications/communications-service";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";

const secret = "test-session-secret";
const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";

async function setup() {
  let id = 0;
  const now = () => new Date("2026-08-10T12:00:00.000Z");
  const communications = new CommunicationsService({
    repository: new MemoryCommunicationsRepository(),
    newId: () => `comm-${++id}`,
    now,
  });
  const events = new EventService({
    repository: new MemoryEventRepository(),
    newId: () => `event-${++id}`,
    now,
  });
  const app = createHttpApp(
    events,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    communications,
  );
  const token = await createDemoSession("organizer", secret, 2_000);
  return {
    app,
    headers: { cookie: `greenroom_session=${token}`, "content-type": "application/json" },
  };
}

describe("communications HTTP acceptance", () => {
  it("lets an organizer create, enqueue, inspect, and recover a delivery", async () => {
    const { app, headers } = await setup();
    expect(
      (
        await app.request("/api/communications/templates", {
          method: "POST",
          headers,
          body: JSON.stringify({
            organizationId,
            key: "invite",
            version: 1,
            channel: "email",
            subject: "Invite",
            body: "Hello",
          }),
        })
      ).status,
    ).toBe(201);
    const queued = await app.request("/api/communications/deliveries", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId,
        eventId,
        idempotencyKey: "invite:1",
        triggerType: "speaker.invited",
        channel: "email",
        recipientRef: "speaker:1",
        payload: {},
        templateKey: "invite",
      }),
    });
    expect(queued.status).toBe(202);
    const delivery = ((await queued.json()) as { delivery: { id: string } }).delivery;
    const history = await app.request(
      `/api/communications/history?organizationId=${organizationId}&eventId=${eventId}`,
      { headers },
    );
    await expect(history.json()).resolves.toMatchObject({
      history: [{ delivery: { id: delivery.id, state: "queued" }, attempts: [] }],
    });
  });

  it("denies non-organizers before parsing or writing", async () => {
    const { app } = await setup();
    const reviewer = await createDemoSession("reviewer", secret, 2_000);
    const response = await app.request("/api/communications/deliveries", {
      method: "POST",
      headers: { cookie: `greenroom_session=${reviewer}` },
      body: "{",
    });
    expect(response.status).toBe(403);
  });
});
