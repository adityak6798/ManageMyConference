// @acceptance ACC-CFP
import { API_CONTRACT_VERSION, API_VERSION_HEADER } from "@greenroom/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submissionThrottle } from "../src/transport/http/throttle";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { CfpService } from "../src/application/cfp/cfp-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";
const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const secret = "cfp-test-secret";
/** Save a form and publish it, so the public submission route has something to validate against. */
async function publish(
  app: Awaited<ReturnType<typeof setup>>["app"],
  cookie: Record<string, string>,
  fields: Record<string, unknown>[],
) {
  const saved = await app.request(`/api/events/${eventId}/cfp`, {
    method: "PUT",
    headers: cookie,
    body: JSON.stringify({ title: "Speak", description: "", fields, expectedVersion: 0 }),
  });
  expect(saved.status).toBe(200);
  const published = await app.request(`/api/events/${eventId}/cfp/state`, {
    method: "POST",
    headers: cookie,
    body: JSON.stringify({ state: "publish" }),
  });
  expect(published.status).toBe(200);
}
async function setup() {
  let id = 0;
  const repository = new MemoryCfpRepository();
  const cfp = new CfpService(
    repository,
    () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    () => new Date("2026-08-10T12:00:00Z"),
    new MemorySubmittedProposalAdapter(),
  );
  const eventRepository = new MemoryEventRepository();
  await eventRepository.create({
    id: eventId,
    organizationId: "00000000-0000-4000-8000-000000000010",
    name: "Public CFP Event",
    timezone: "UTC",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const events = new EventService({
    repository: eventRepository,
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
  // The submission counter lives in the isolate, not in the app, because the worker builds a
  // new app per request. Each test starts from an empty window.
  beforeEach(() => submissionThrottle.reset());

  it("keeps drafts private, validates, publishes, and returns the same confirmation on retry", async () => {
    const { app, cookie } = await setup();
    const path = `/api/events/${eventId}/cfp`;
    const draft = await app.request(path, {
      method: "PUT",
      headers: cookie,
      body: JSON.stringify({
        title: "Speak",
        description: "",
        expectedVersion: 0,
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
  it("returns 409 for a stale organizer draft and retains the winning edit", async () => {
    const { app, cookie } = await setup();
    const path = `/api/events/${eventId}/cfp`;
    const save = (title: string, expectedVersion: number) =>
      app.request(path, {
        method: "PUT",
        headers: cookie,
        body: JSON.stringify({
          title,
          expectedVersion,
          fields: [{ id: "title", type: "short_text", label: "Title" }],
        }),
      });
    expect((await save("Original", 0)).status).toBe(200);
    expect((await save("Winning edit", 1)).status).toBe(200);
    const stale = await save("Stale overwrite", 1);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", message: expect.stringContaining("Reload") },
    });
    await expect((await app.request(path, { headers: cookie })).json()).resolves.toMatchObject({
      cfp: { title: "Winning edit", version: 2 },
    });
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
  it("lists event metadata for a direct public session", async () => {
    const { app } = await setup();
    const response = await app.request("/api/events/assigned", {
      headers: { cookie: `greenroom_session=${await createDemoSession("public", secret, 2_000)}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [{ id: eventId, name: "Public CFP Event" }],
    });
  });

  it("bounds the one unauthenticated write: per-answer, per-field, and per-key", async () => {
    const { app, cookie } = await setup();
    await publish(app, cookie, [
      { id: "title", type: "short_text", label: "Title", required: true },
      // The organizer's own limit, which the form advertises and the server enforces.
      { id: "abstract", type: "long_text", label: "Abstract", maxLength: 400 },
    ]);
    const submissionPath = `/api/public/events/${eventId}/submissions`;
    const submit = (answers: Record<string, string>, key = crypto.randomUUID()) =>
      app.request(submissionPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key, answers }),
      });

    // Issue #64 measured a 120 KB abstract accepted with 201 and persisted. The body schema
    // now refuses it before any domain sees it.
    const flood = await submit({ title: "Real", abstract: "x".repeat(120_000) });
    expect(flood.status).toBe(400);
    await expect(flood.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { "answers.abstract": [expect.any(String)] },
      },
    });

    // Under the schema ceiling but over what this field advertises: refused per field.
    const overField = await submit({ title: "Real", abstract: "x".repeat(401) });
    expect(overField.status).toBe(400);
    await expect(overField.json()).resolves.toMatchObject({
      error: { fieldErrors: { "answers.abstract": ["Keep this answer under 400 characters."] } },
    });
    // The type default applies to a field that declares no limit of its own.
    const overDefault = await submit({ title: "x".repeat(201) });
    expect(overDefault.status).toBe(400);
    await expect(overDefault.json()).resolves.toMatchObject({
      error: { fieldErrors: { "answers.title": ["Keep this answer under 200 characters."] } },
    });

    // More keys than any form can have fields.
    const keys = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`field-${index}`, "value"]),
    );
    expect((await submit(keys)).status).toBe(400);

    // Nothing above was persisted: the next honest submission is the first one stored.
    const accepted = await submit({ title: "Real", abstract: "Short enough" });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).submission.confirmationId).toBeTruthy();
    // 201s are never stored by a cache — only public GETs are.
    expect(accepted.headers.get("cache-control")).toBe("no-store");
  });

  it("throttles submissions per address, and a caller cannot buy a fresh budget", async () => {
    const { app, cookie } = await setup();
    await publish(app, cookie, [{ id: "title", type: "short_text", label: "Title" }]);
    const submit = (path: string, address: string) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": address },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), answers: { title: "Hi" } }),
      });
    const path = `/api/public/events/${eventId}/submissions`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1)
      statuses.push((await submit(path, "203.0.113.7")).status);
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 201));
    const refused = await submit(path, "203.0.113.7");
    expect(statuses.at(-1)).toBe(429);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } });
    // A different submitter is unaffected: the budget is per address.
    expect((await submit(path, "203.0.113.8")).status).toBe(201);
    // But the SAME address gets no fresh budget by naming a different event. The event id comes
    // from the path and is never checked for existence, so keying on it would have let one
    // client mint unlimited counters — and, against a bounded key table, evict its own spent one
    // and start again. Keying on the address alone is what closes that.
    expect(
      (await submit(`/api/public/events/${otherEventId}/submissions`, "203.0.113.7")).status,
    ).toBe(429);
    // Not even a syntactically valid event that does not exist.
    expect(
      (
        await submit(
          "/api/public/events/00000000-0000-4000-8000-0000000000ff/submissions",
          "203.0.113.7",
        )
      ).status,
    ).toBe(429);
  });

  it("is embeddable and cacheable from a third-party origin", async () => {
    const { app, cookie } = await setup();
    await publish(app, cookie, [{ id: "title", type: "short_text", label: "Title" }]);
    const path = `/api/public/events/${eventId}/cfp`;

    // Preflight used to reach `app.notFound` and 404, which no browser accepts.
    const preflight = await app.request(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://conference.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(Number(preflight.headers.get("access-control-max-age"))).toBeGreaterThan(0);
    // Preflight for the write path is answered too, not only for reads.
    expect(
      (
        await app.request(`/api/public/events/${eventId}/submissions`, {
          method: "OPTIONS",
          headers: {
            origin: "https://conference.example",
            "access-control-request-method": "POST",
          },
        })
      ).status,
    ).toBe(204);

    const cross = await app.request(path, { headers: { origin: "https://conference.example" } });
    expect(cross.status).toBe(200);
    expect(cross.headers.get("access-control-allow-origin")).toBe("*");
    // Storable by anyone, usable by nobody without asking: `PRD-PUB-001` promises the
    // applicant view reflects close and reopen immediately, and any `max-age` is exactly a
    // window in which a browser answers "open" out of its own store instead of asking.
    expect(cross.headers.get("cache-control")).toBe("public, no-cache");
    expect(cross.headers.get("cache-control")).not.toMatch(/max-age|s-maxage|stale-while/);
    const validator = cross.headers.get("etag");
    expect(validator).toBeTruthy();
    expect(cross.headers.get("access-control-expose-headers")).toContain("etag");

    // Revalidated from the same third-party origin, because `allowHeaders` invites
    // `If-None-Match` and a browser discards a 304 that comes back without the CORS header.
    const revalidated = await app.request(path, {
      headers: {
        origin: "https://conference.example",
        "if-none-match": validator ?? "",
        "x-correlation-id": "cfp-revalidation",
      },
    });
    expect(revalidated.status).toBe(304);
    // The saving is here: an unchanged form costs a bodyless 304 on every read.
    expect(revalidated.headers.get("cache-control")).toBe("public, no-cache");
    expect(revalidated.headers.get("access-control-allow-origin")).toBe("*");
    expect(revalidated.headers.get(API_VERSION_HEADER)).toBe(API_CONTRACT_VERSION);
    // The correlation id survives the 304, or a caller could not report a bad response.
    expect(revalidated.headers.get("x-correlation-id")).toBe("cfp-revalidation");

    // Closing the CFP is visible to the very next conditional read, which is the whole
    // point of validating instead of expiring: the same `If-None-Match` that was answered
    // 304 a moment ago now gets the closed form back.
    const closed = await app.request(`/api/events/${eventId}/cfp/state`, {
      method: "POST",
      headers: cookie,
      body: JSON.stringify({ state: "close" }),
    });
    expect(closed.status).toBe(200);
    const afterClose = await app.request(path, {
      headers: { origin: "https://conference.example", "if-none-match": validator ?? "" },
    });
    expect(afterClose.status).toBe(200);
    await expect(afterClose.json()).resolves.toMatchObject({ cfp: { status: "closed" } });
    const closedValidator = afterClose.headers.get("etag");
    expect(closedValidator).not.toBe(validator);

    // And reopening is visible the same way, with no window in between.
    expect(
      (
        await app.request(`/api/events/${eventId}/cfp/state`, {
          method: "POST",
          headers: cookie,
          body: JSON.stringify({ state: "reopen" }),
        })
      ).status,
    ).toBe(200);
    const afterReopen = await app.request(path, {
      headers: { origin: "https://conference.example", "if-none-match": closedValidator ?? "" },
    });
    expect(afterReopen.status).toBe(200);
    await expect(afterReopen.json()).resolves.toMatchObject({ cfp: { status: "open" } });

    // "Not published" is never cached, so publishing later is visible at once.
    const missing = await app.request(`/api/public/events/${otherEventId}/cfp`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("answers every public route anonymously and cross-origin, preflight included", async () => {
    const { app, cookie } = await setup();
    await publish(app, cookie, [{ id: "title", type: "short_text", label: "Title" }]);
    const origin = "https://conference.example";
    for (const path of [
      `/api/public/events/${eventId}/cfp`,
      `/api/public/events/${eventId}/submissions`,
      "/api/public/events/some-published-slug",
      "/api/public/events/some-published-slug/schedule",
    ]) {
      // No route in this namespace may demand a session.
      const anonymous = await app.request(path, { headers: { origin } });
      expect({ path, status: anonymous.status }).not.toEqual({ path, status: 401 });
      // Whatever the outcome, a browser on another origin can read it.
      expect({ path, allowed: anonymous.headers.get("access-control-allow-origin") }).toEqual({
        path,
        allowed: "*",
      });
      const preflight = await app.request(path, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
      expect({ path, status: preflight.status }).toEqual({ path, status: 204 });
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    }
    // The one route that did demand a session has left the namespace entirely.
    expect((await app.request("/api/public/events")).status).toBe(404);
  });
});
