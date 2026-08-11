// @acceptance ACC-HARNESS
import { describe, expect, it, vi } from "vitest";
import { healthResponseSchema } from "@greenroom/contracts";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { CrmService } from "../src/application/crm/crm-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import type { Actor, Capability } from "../src/application/identity/actor";
import { PublicationService } from "../src/application/publishing/publication-service";
import { createHttpApp, type StructuredLogger } from "../src/transport/http/app";

type Persona = "organizer" | "reviewer" | "speaker" | "public";

const secret = "test-session-secret";
const testCrm = () =>
  new CrmService({
    repository: new MemoryCrmRepository(),
    speakerConversion: { createOrLink: async () => ({ speakerId: crypto.randomUUID() }) },
    // These harness cases never assign an owner; the CRM's own suites cover eligibility.
    identities: { listAssignableOwnersForEvent: async () => [] },
    newId: () => crypto.randomUUID(),
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
const createTestApp = () => {
  const service = new EventService({
    repository: new MemoryEventRepository(),
    newId: () => "123e4567-e89b-12d3-a456-426614174000",
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    app: createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
    ),
    logger,
  };
};
const cookieFor = async (persona: "organizer" | "reviewer" | "speaker" | "public") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
});

describe("events HTTP transport", () => {
  it("returns health that matches the SQL/R2 runtime contract", async () => {
    const { app } = createTestApp();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const health = healthResponseSchema.parse(await response.json());
    expect(health.providerMode).toBe("sql-r2");
    // A deployment supplies no build identity, and the field is absent rather than null.
    expect(health.build).toBeUndefined();
  });

  it("reports the checkout and commit it was started from when the launcher supplies them", async () => {
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const build = { root: "/repo/worktrees/mine", commit: "a".repeat(40) };
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      build,
    );
    // Both routes answer, because the browser suite reads the proxied one through Vite to
    // prove the web server in front of it points at this API (issue #90).
    for (const route of ["/health", "/api/health"]) {
      const response = await app.request(route);
      expect(response.status).toBe(200);
      expect(healthResponseSchema.parse(await response.json()).build).toEqual(build);
    }
  });

  it("keeps health free of secrets and cookies", async () => {
    const { app } = createTestApp();
    const body = await (await app.request("/health")).text();
    expect(body).not.toContain(secret);
    expect(body.toLowerCase()).not.toContain("cookie");
    expect(body.toLowerCase()).not.toContain("sessionsecret");
  });

  it("returns the seeded identity, memberships, event roles, and capabilities", async () => {
    const { app } = createTestApp();
    const organizer = await app.request("/api/session", { headers: await cookieFor("organizer") });
    expect(organizer.status).toBe(200);
    await expect(organizer.json()).resolves.toMatchObject({
      actor: { id: "seed-organizer", persona: "organizer" },
      organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
      eventAccess: expect.arrayContaining([expect.objectContaining({ role: "organizer" })]),
      capabilities: expect.arrayContaining(["events:create"]),
    });
    const publicSession = await app.request("/api/session", { headers: await cookieFor("public") });
    await expect(publicSession.json()).resolves.toMatchObject({
      actor: { persona: "public" },
      organizations: [],
      eventAccess: [expect.objectContaining({ role: "public" })],
    });
    expect((await app.request("/api/events", { headers: await cookieFor("public") })).status).toBe(
      403,
    );
  });

  it("distinguishes unauthenticated access and scopes reviewer events", async () => {
    const { app, logger } = createTestApp();
    const unauthenticated = await app.request("/api/events", {
      headers: { "x-correlation-id": "test-correlation" },
    });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", correlationId: "test-correlation" },
    });
    const reviewer = await app.request("/api/events", { headers: await cookieFor("reviewer") });
    expect(reviewer.status).toBe(200);
    await expect(reviewer.json()).resolves.toEqual({ events: [] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("denies event mutations before persistence", async () => {
    const create = vi.fn();
    const service = new EventService({
      repository: {
        create,
        list: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
    );
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

  it("serves assigned events from /api/events/assigned, never from the public namespace", async () => {
    const { app } = createTestApp();
    // The route this replaced lived under `/api/public` and answered 401 to anonymous
    // callers. It is authenticated, so it is named as such — and the old path is gone.
    expect((await app.request("/api/events/assigned")).status).toBe(401);
    expect((await app.request("/api/public/events")).status).toBe(404);
    // The public demo identity holds no `events:read`, so `/api/events` refuses it; the
    // assigned list is exactly what that identity is allowed to see.
    const publicHeaders = await cookieFor("public");
    expect((await app.request("/api/events", { headers: publicHeaders })).status).toBe(403);
    const assigned = await app.request("/api/events/assigned", { headers: publicHeaders });
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toEqual({ events: [] });
    // The static segment has to beat `/api/events/:eventId`, which would 400 on "assigned".
    expect(
      (await app.request("/api/events/assigned", { headers: await cookieFor("organizer") })).status,
    ).toBe(200);
  });

  it("authorizes an event role by capability, whatever order the directory returns roles in", async () => {
    // The seeded organizer is also a reviewer of the demo event. Authorization used to read
    // only the first access entry, so it survived on `ORDER BY role` alone: reverse the two
    // and the organizer lost the event (`ARC-AUTH-001`).
    const eventId = "00000000-0000-4000-8000-000000000001";
    const reviewerAccess = {
      eventId,
      role: "reviewer" as const,
      capabilities: new Set<Capability>(["events:read", "review:evaluate"]),
    };
    const appFor = (resolveActor: (persona: Persona) => Promise<Actor | null>) =>
      createHttpApp(
        new EventService({
          repository: new MemoryEventRepository(),
          newId: () => crypto.randomUUID(),
          now: () => new Date(),
        }),
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        { demoMode: true, sessionSecret: secret, now: () => 1_000, resolveActor },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new PublicationService({
          // Nothing is stored, so an authorized organizer gets 404 "nothing published yet"
          // and a denied one gets 403. That difference is the whole assertion.
          findPublicBySlug: async () => null,
          findByEventId: async () => null,
          publish: async () => null,
          unpublish: async () => null,
        }),
      );
    const withRoleOrder = (reviewerFirst: boolean) => async (persona: Persona) => {
      const actor = await resolveSeededDemoActor(persona);
      if (persona !== "organizer") return actor;
      const organizerAccess = actor.eventAccess.filter((access) => access.eventId === eventId);
      return {
        ...actor,
        eventAccess: reviewerFirst
          ? [reviewerAccess, ...organizerAccess]
          : [...organizerAccess, reviewerAccess],
      };
    };
    for (const reviewerFirst of [false, true]) {
      const app = appFor(withRoleOrder(reviewerFirst));
      const headers = await cookieFor("organizer");
      for (const path of [
        `/api/publishing/events/${eventId}/preview`,
        `/api/publishing/events/${eventId}/publish`,
      ]) {
        const method = path.endsWith("preview") ? "GET" : "POST";
        const response = await app.request(path, { method, headers });
        expect({ reviewerFirst, path, status: response.status }).toEqual({
          reviewerFirst,
          path,
          status: 404,
        });
        await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
        // `/api/publishing/*` is organizer-only and must never pick up the public
        // namespace's CORS or shared-cache policy just because its prefix looks similar.
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("cache-control")).toBeNull();
      }
    }
    // A reviewer-only actor is still refused, in either shape.
    const reviewerOnly = appFor(async (persona) =>
      persona === "reviewer"
        ? { ...(await resolveSeededDemoActor("reviewer")), eventAccess: [reviewerAccess] }
        : resolveSeededDemoActor(persona),
    );
    const denied = await reviewerOnly.request(`/api/publishing/events/${eventId}/publish`, {
      method: "POST",
      headers: await cookieFor("reviewer"),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
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
      body: JSON.stringify({
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Greenroom Summit",
        timezone: "America/Los_Angeles",
      }),
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
      repository: {
        create,
        list: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
    );
    for (const name of ["   ", "x".repeat(121)]) {
      const response = await app.request("/api/events", {
        method: "POST",
        headers: {
          ...(await cookieFor("organizer")),
          "content-type": "application/json",
          "x-correlation-id": "validation-correlation",
        },
        body: JSON.stringify({
          organizationId: "00000000-0000-4000-8000-000000000010",
          name,
          timezone: "UTC",
        }),
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
    const app = createHttpApp(service, logger, { demoMode: false }, testCrm());
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

  it("validates and tenant-scopes event identity queries without enumeration", async () => {
    const repository = new MemoryEventRepository();
    await repository.create({
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "Assigned Summit",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    await repository.create({
      id: "00000000-0000-4000-8000-000000000099",
      organizationId: "00000000-0000-4000-8000-000000000099",
      name: "Outside Summit",
      timezone: "UTC",
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    const service = new EventService({
      repository,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
    );

    expect(
      (await app.request("/api/events/not-a-uuid", { headers: await cookieFor("organizer") }))
        .status,
    ).toBe(400);
    expect((await app.request("/api/events/not-a-uuid")).status).toBe(401);
    expect(
      (
        await app.request("/api/events/00000000-0000-4000-8000-000000000001", {
          headers: await cookieFor("speaker"),
        })
      ).status,
    ).toBe(200);
    for (const persona of ["organizer", "speaker"] as const) {
      const hidden = await app.request("/api/events/00000000-0000-4000-8000-000000000099", {
        headers: await cookieFor(persona),
      });
      expect(hidden.status).toBe(404);
      await expect(hidden.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    expect(
      (
        await app.request("/api/events/00000000-0000-4000-8000-000000000001", {
          headers: await cookieFor("public"),
        })
      ).status,
    ).toBe(403);
  });

  it("logs unexpected failures exactly once with request dimensions", async () => {
    const service = new EventService({
      repository: {
        create: vi.fn(),
        list: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        findById: vi.fn().mockResolvedValue(null),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      testCrm(),
    );
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
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "failure-correlation",
        method: "GET",
        path: "/api/events",
        status: 500,
        actorId: "seed-organizer",
        operation: "GET /api/events",
        errorName: "Error",
        // The correlation id is only diagnosable if the log carries the cause.
        errorMessage: "storage unavailable",
        errorStack: expect.stringContaining("storage unavailable"),
      }),
      "request.exception",
    );
  });

  it("keeps stacks out of the log when demo mode is off", async () => {
    const service = new EventService({
      repository: {
        create: vi.fn(),
        list: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        findById: vi.fn().mockResolvedValue(null),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // The public projection route is the one unauthenticated read that can reach a
    // repository, so it is where an anonymous 500 can be observed without demo mode.
    const app = createHttpApp(service, logger, { demoMode: false }, {
      publicBySlug: vi.fn().mockRejectedValue(new Error("storage unavailable")),
    } as unknown as Parameters<typeof createHttpApp>[3]);
    const response = await app.request("/api/public/events/greenroom-demo-summit", {
      headers: { "x-correlation-id": "production-correlation" },
    });
    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "storage unavailable" }),
      "request.exception",
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorStack: expect.anything() }),
      expect.anything(),
    );
  });
});
