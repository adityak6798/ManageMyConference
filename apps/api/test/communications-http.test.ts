// @acceptance ACC-INTEGRATION
import { describe, expect, it, vi } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import { CommunicationsService } from "../src/application/communications/communications-service";
import { OutboxWorker } from "../src/application/communications/outbox-worker";
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
  const repository = new MemoryCommunicationsRepository();
  const communications = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
        candidateEventId === eventId && candidateOrganizationId === organizationId,
    },
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
    repository,
    now,
    headers: { cookie: `greenroom_session=${token}`, "content-type": "application/json" },
  };
}

describe("communications HTTP acceptance", () => {
  it("lets an organizer create, enqueue, inspect, and recover a delivery", async () => {
    const { app, headers, repository, now } = await setup();
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
    const terminalProvider = new DeterministicProvider("terminal");
    await new OutboxWorker(
      repository,
      { email: terminalProvider, airtable: terminalProvider, accelevents: terminalProvider },
      { newId: () => crypto.randomUUID(), now },
    ).runOne();
    const history = await app.request(
      `/api/communications/history?organizationId=${organizationId}&eventId=${eventId}`,
      { headers },
    );
    await expect(history.json()).resolves.toMatchObject({
      history: [
        {
          delivery: { id: delivery.id, state: "terminal" },
          attempts: [expect.objectContaining({ outcome: "terminal_failure" })],
        },
      ],
    });
    const retry = await app.request(
      `/api/communications/deliveries/${delivery.id}/retry?organizationId=${organizationId}`,
      { method: "POST", headers },
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ delivery: { state: "queued" } });
    const recoveredHistory = await app.request(
      `/api/communications/history?organizationId=${organizationId}&eventId=${eventId}`,
      { headers },
    );
    await expect(recoveredHistory.json()).resolves.toMatchObject({
      history: [{ delivery: { state: "queued" }, attempts: [expect.any(Object)] }],
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

  it("rejects invalid projection semantics at the HTTP contract", async () => {
    const { app, headers } = await setup();
    const response = await app.request("/api/communications/deliveries", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId,
        eventId,
        idempotencyKey: "invalid",
        triggerType: "projection.requested",
        channel: "airtable",
        recipientRef: "session:1",
        payload: {},
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { fieldErrors: { projectionVersion: expect.any(Array) } },
    });
  });

  it("maps expected template and recovery failures to stable 4xx envelopes", async () => {
    const { app, headers } = await setup();
    const missingTemplate = await app.request("/api/communications/deliveries", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId,
        eventId,
        idempotencyKey: "missing-template",
        triggerType: "speaker.invited",
        channel: "email",
        recipientRef: "speaker:1",
        payload: {},
        templateKey: "absent",
      }),
    });
    expect(missingTemplate.status).toBe(404);
    await expect(missingTemplate.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    const missingDelivery = await app.request(
      `/api/communications/deliveries/absent/retry?organizationId=${organizationId}`,
      { method: "POST", headers },
    );
    expect(missingDelivery.status).toBe(404);
  });
});
