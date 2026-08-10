// @acceptance ACC-HARNESS
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { createDemoSession } from "../src/application/identity/demo-session";
import { createHttpApp, type StructuredLogger } from "../src/transport/http/app";

const secret = "test-session-secret";
const createTestApp = () => {
  const service = new EventService({
    repository: new MemoryEventRepository(),
    newId: () => "123e4567-e89b-12d3-a456-426614174000",
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    app: createHttpApp(service, logger, {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
    }),
    logger,
  };
};
const cookieFor = async (persona: "organizer" | "reviewer") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
});

describe("events HTTP transport", () => {
  it("distinguishes unauthenticated from forbidden and logs denials", async () => {
    const { app, logger } = createTestApp();
    const unauthenticated = await app.request("/api/events", {
      headers: { "x-correlation-id": "test-correlation" },
    });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", correlationId: "test-correlation" },
    });
    const forbidden = await app.request("/api/events", { headers: await cookieFor("reviewer") });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("denies event mutations before persistence", async () => {
    const create = vi.fn();
    const service = new EventService({
      repository: { create, list: vi.fn().mockResolvedValue([]) },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(service, logger, {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
    });
    const request = (headers: Record<string, string>) =>
      app.request("/api/events", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Forbidden Summit", timezone: "UTC" }),
      });

    expect((await request({})).status).toBe(401);
    expect((await request(await cookieFor("reviewer"))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("authorizes event mutations before parsing their body", async () => {
    const { app } = createTestApp();
    const malformed = { method: "POST", body: "{" };
    expect((await app.request("/api/events", malformed)).status).toBe(401);
    expect(
      (await app.request("/api/events", { ...malformed, headers: await cookieFor("reviewer") }))
        .status,
    ).toBe(403);
  });

  it("ignores attacker-controlled roles and malformed correlation IDs", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/events", {
      headers: { "x-demo-role": "organizer", "x-correlation-id": "bad value with spaces" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("validates, persists, reloads, and logs organizer requests", async () => {
    const { app, logger } = createTestApp();
    const session = await app.request("/api/demo-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: "organizer" }),
    });
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const headers = { "content-type": "application/json", cookie: cookie ?? "" };
    const created = await app.request("/api/events", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Greenroom Summit", timezone: "America/Los_Angeles" }),
    });
    expect(created.status).toBe(201);
    const reloaded = await app.request("/api/events", { headers });
    await expect(reloaded.json()).resolves.toMatchObject({
      events: [{ name: "Greenroom Summit" }],
    });
    expect(logger.info).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/events",
        status: 201,
        actorId: "seed-organizer",
        operation: "POST /api/events",
      }),
      "request.completed",
    );
  });

  it("issues a bounded secure cookie for HTTPS demo sessions", async () => {
    const { app } = createTestApp();
    const response = await app.request("https://greenroom.test/api/demo-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: "organizer" }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
  });

  it("rejects semantic input errors without writing", async () => {
    const create = vi.fn();
    const service = new EventService({
      repository: { create, list: vi.fn().mockResolvedValue([]) },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(service, logger, {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
    });
    for (const name of ["   ", "x".repeat(121)]) {
      const response = await app.request("/api/events", {
        method: "POST",
        headers: {
          ...(await cookieFor("organizer")),
          "content-type": "application/json",
          "x-correlation-id": "validation-correlation",
        },
        body: JSON.stringify({ name, timezone: "UTC" }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          correlationId: "validation-correlation",
          fieldErrors: { name: expect.any(Array) },
        },
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a standard 400 for malformed JSON", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/events", {
      method: "POST",
      headers: { ...(await cookieFor("organizer")), "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", correlationId: expect.any(String) },
    });
  });

  it("does not expose the demo endpoint outside explicit demo mode", async () => {
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(service, logger, { demoMode: false });
    expect((await app.request("/api/demo-session", { method: "POST", body: "{}" })).status).toBe(
      404,
    );
  });

  it("returns the standard envelope for unknown routes", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/unknown", {
      headers: { "x-correlation-id": "missing-correlation" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
        correlationId: "missing-correlation",
      },
    });
  });

  it("logs unexpected failures exactly once with request dimensions", async () => {
    const service = new EventService({
      repository: {
        create: vi.fn(),
        list: vi.fn().mockRejectedValue(new Error("storage unavailable")),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(service, logger, {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
    });
    const response = await app.request("/api/events", {
      headers: { ...(await cookieFor("organizer")), "x-correlation-id": "failure-correlation" },
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        correlationId: "failure-correlation",
      },
    });
    expect(JSON.stringify(body)).not.toContain("storage unavailable");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.anything() }),
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "failure-correlation",
        method: "GET",
        path: "/api/events",
        status: 500,
        actorId: "seed-organizer",
        operation: "GET /api/events",
      }),
      "request.exception",
    );
  });
});
