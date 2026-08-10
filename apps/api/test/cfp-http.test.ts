// @acceptance ACC-CFP
import { describe, expect, it, vi } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { CfpService } from "../src/application/cfp/cfp-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";
const eventId = "00000000-0000-4000-8000-000000000001";
const secret = "cfp-test-secret";
async function setup() {
  let id = 0;
  const repository = new MemoryCfpRepository();
  const cfp = new CfpService(
    repository,
    () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    () => new Date("2026-08-10T12:00:00Z"),
  );
  const events = new EventService({
    repository: new MemoryEventRepository(),
    newId: crypto.randomUUID,
    now: () => new Date(),
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
    cfp,
  );
  const cookie = {
    cookie: `greenroom_session=${await createDemoSession("organizer", secret, 2_000)}`,
    "content-type": "application/json",
  };
  return { app, cookie };
}
describe("CFP HTTP journey", () => {
  it("keeps drafts private, validates, publishes, and returns the same confirmation on retry", async () => {
    const { app, cookie } = await setup();
    const path = `/api/events/${eventId}/cfp`;
    const draft = await app.request(path, {
      method: "PUT",
      headers: cookie,
      body: JSON.stringify({
        title: "Speak",
        description: "",
        fields: [{ id: "email", type: "email", label: "Email", required: true }],
      }),
    });
    expect(draft.status).toBe(200);
    expect((await app.request(`/api/public/events/${eventId}/cfp`)).status).toBe(404);
    expect(
      (
        await app.request(`${path}/state`, {
          method: "POST",
          headers: cookie,
          body: JSON.stringify({ state: "close" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`${path}/state`, {
          method: "POST",
          headers: cookie,
          body: JSON.stringify({ state: "publish" }),
        })
      ).status,
    ).toBe(200);
    const submissionPath = `/api/public/events/${eventId}/submissions`;
    const invalid = await app.request(submissionPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "retry-key", answers: { email: "bad" } }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { fieldErrors: { "answers.email": expect.any(Array) } },
    });
    const request = () =>
      app.request(submissionPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "stable-retry",
          answers: { email: "speaker@example.com" },
        }),
      });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });
  it("rejects duplicate field IDs and selects without options", async () => {
    const { app, cookie } = await setup();
    for (const fields of [
      [
        { id: "same", type: "short_text", label: "One" },
        { id: "same", type: "email", label: "Two" },
      ],
      [{ id: "choice", type: "select", label: "Choose", required: true, options: [] }],
    ]) {
      const response = await app.request(`/api/events/${eventId}/cfp`, {
        method: "PUT",
        headers: cookie,
        body: JSON.stringify({ title: "Invalid", fields }),
      });
      expect(response.status).toBe(400);
    }
  });
  it("rejects unauthorized and cross-event organizer access", async () => {
    const { app } = await setup();
    expect((await app.request(`/api/events/${eventId}/cfp`)).status).toBe(401);
    const reviewer = {
      cookie: `greenroom_session=${await createDemoSession("reviewer", secret, 2_000)}`,
    };
    expect((await app.request(`/api/events/${eventId}/cfp`, { headers: reviewer })).status).toBe(
      403,
    );
  });
});
