// @acceptance ACC-HARNESS

import {
  authConfigResponseSchema,
  healthResponseSchema,
  sessionResponseSchema,
  signOutResponseSchema,
} from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import type { AgendaService } from "../src/application/agenda/public";
import type { ContentService } from "../src/application/content/content-service";
import { CrmService } from "../src/application/crm/crm-service";
import { EventService } from "../src/application/events/event-service";
import {
  type Actor,
  type Capability,
  requireEventCapability,
} from "../src/application/identity/actor";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createEventToken, createUserSession } from "../src/application/identity/real-auth";
import { PublicationService } from "../src/application/publishing/publication-service";
import type { ReviewService } from "../src/application/review/review-service";
import {
  createHttpApp,
  createHttpAppFrom,
  type GoogleAuthProvider,
  type StructuredLogger,
} from "../src/transport/http/app";
import { memorySessionStore } from "./support/memory-session-store";

type Persona = "organizer" | "reviewer" | "speaker" | "public";

const secret = "test-session-secret";
const testCrm = () =>
  new CrmService({
    repository: new MemoryCrmRepository(),
    speakerConversion: { createOrLink: async () => ({ speakerId: crypto.randomUUID() }) },
    // These harness cases never assign an owner; the CRM's own suites cover eligibility.
    identities: { listAssignableOwnersForEvent: async () => [] },
    // Nor do they reach the organization directory, whose own suites cover both.
    events: {
      belongsToOrganization: async () => false,
      listEventIdsInOrganization: async () => [],
    },
    outreach: {
      prepare: async () => undefined,
      send: async () => ({ deliveryId: "unused", created: true }),
    },
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

/**
 * A real signed-in organizer: the seeded persona's shape, under an id that is not a seeded one.
 *
 * The id is the whole point. Both issuing routes refuse a subject for which `isDemoPersonaId`
 * holds, because `seed/reset.sql` gives the personas real addresses and a real sign-in must never
 * land on one (`docs/architecture/authorization.md`, rule 3). A fixture that signs in *as*
 * `seed-organizer` is exercising a path the product deliberately refuses, which is not what these
 * cases are about.
 */
const realOrganizer = async () => ({
  ...(await resolveSeededDemoActor("organizer")),
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
});

/** The attempt ids a response leaves the browser holding — `""` when it clears them. */
const attemptCookieValue = (response: Response) => {
  const value = (response.headers.get("set-cookie")?.match(/greenroom_oauth=([^;]*)/) ?? [])[1];
  return value ?? "";
};

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

  /**
   * Which credential resolved, reported so the console can act on it.
   *
   * A persona and a real session arrive in the same cookie and are undone differently — one is
   * switched, the other signed out of — so a client that cannot tell them apart either offers a
   * sign-out that does nothing or withholds one from somebody who needs it. Both happened before
   * this field existed. Nothing else in either suite asserts it.
   */
  it("says which kind of credential the session was resolved from", async () => {
    const { app } = createTestApp();
    const demo = await app.request("/api/session", { headers: await cookieFor("organizer") });
    expect(sessionResponseSchema.parse(await demo.json()).authentication).toBe("demo");

    // A real user session on the same demo-mode deployment, which is the configuration the
    // middleware exists to support and the one where the distinction is load-bearing.
    const actor = await realOrganizer();
    const googleSessions = memorySessionStore();
    const withGoogle = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
        google: {
          start: async () => ({ authorizationUrl: "https://accounts.google.com/", attemptId: "a" }),
          complete: async () => ({ spentAttemptId: null, outcome: { status: "refused" } }),
          resolveUserActor: async (userId) => (userId === actor.id ? actor : null),
        },
        sessions: googleSessions,
      },
      testCrm(),
    );
    googleSessions.seed({ id: "sid-real", userId: actor.id, issuedAt: 0, expiresAt: 2_000 });
    const session = await createUserSession("sid-real", actor.id, secret, 2_000);
    const real = await withGoogle.request("/api/session", {
      headers: { cookie: `greenroom_session=${session}` },
    });
    expect(sessionResponseSchema.parse(await real.json()).authentication).toBe("session");

    // An event-scoped bearer is neither, and saying so is what stops the console offering to sign
    // a token holder out of a session they never had. Asserted on a production app, because a
    // demo-mode deployment resolves no bearer at all — the middleware's demo branch reads the
    // cookie and nothing else, which is why `/api/auth/tokens` is 404 there in the first place.
    const bearerSessions = memorySessionStore();
    const production = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: false,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: async (userId) => (userId === actor.id ? actor : null),
        resolveEmail: async () => null,
        sendLoginCode: async () => undefined,
        saveLoginChallenge: async () => undefined,
        consumeLoginChallenge: async () => null,
        sessions: bearerSessions,
      },
      testCrm(),
    );
    bearerSessions.seed({ id: "sid-bearer", userId: actor.id, issuedAt: 0, expiresAt: 2_000 });
    const bearer = await createEventToken(
      "sid-bearer",
      actor.id,
      "00000000-0000-4000-8000-000000000001",
      secret,
      2_000,
    );
    const token = await production.request("/api/session", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(sessionResponseSchema.parse(await token.json()).authentication).toBe("bearer");
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

  it("keeps overview authentication and authorization as transport-wide refusals", async () => {
    const events = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const authorizeOrganizer = (actor: Actor | null, eventId: string) => {
      requireEventCapability(actor, eventId, "agenda:manage");
      return {};
    };
    const app = createHttpAppFrom({
      events,
      logger,
      auth: {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      content: {
        workspace: async (actor: Actor | null, eventId: string) =>
          authorizeOrganizer(actor, eventId),
      } as unknown as ContentService,
      review: {
        organizerWorkspace: async (actor: Actor | null, eventId: string) =>
          authorizeOrganizer(actor, eventId),
      } as unknown as ReviewService,
      agenda: {
        draft: async (actor: Actor | null, eventId: string) => authorizeOrganizer(actor, eventId),
      } as unknown as AgendaService,
    });
    const path = "/api/events/00000000-0000-4000-8000-000000000001/overview";

    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: await cookieFor("reviewer") })).status).toBe(403);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("denies event mutations before persistence", async () => {
    const create = vi.fn();
    const update = vi.fn().mockResolvedValue(null);
    const service = new EventService({
      repository: {
        create,
        update,
        list: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
        createOrganization: vi.fn(),
        findByProvisioningKey: vi.fn().mockResolvedValue(null),
        discardUnusedOrganization: vi.fn().mockResolvedValue(false),
        listIdsInOrganization: vi.fn().mockResolvedValue([]),
        listAllIdsInOrganization: vi.fn().mockResolvedValue([]),
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
    const patch = (headers: Record<string, string>) =>
      app.request("/api/events/00000000-0000-4000-8000-000000000001", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Leaked rename", timezone: "UTC" }),
      });
    expect((await patch({})).status).toBe(401);
    expect((await patch(await cookieFor("reviewer"))).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
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
          findEventIdBySlug: async () => null,
          saveSettings: async () => null,
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
    const headers = {
      "content-type": "application/json",
      cookie: cookie ?? "",
      "Idempotency-Key": "00000000-0000-4000-8000-000000000498",
    };
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
    const replayed = await app.request("/api/events", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Greenroom Summit",
        timezone: "America/Los_Angeles",
      }),
    });
    expect(replayed.status).toBe(201);
    expect((await replayed.json()).event.id).toBe((await created.json()).event.id);
    const conflicting = await app.request("/api/events", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "A different summit",
        timezone: "America/Los_Angeles",
      }),
    });
    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
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
        update: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
        createOrganization: vi.fn(),
        findByProvisioningKey: vi.fn().mockResolvedValue(null),
        discardUnusedOrganization: vi.fn().mockResolvedValue(false),
        listIdsInOrganization: vi.fn().mockResolvedValue([]),
        listAllIdsInOrganization: vi.fn().mockResolvedValue([]),
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

  it("authenticates a production identity with an emailed code", async () => {
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const actor = await realOrganizer();
    let deliveredCode = "";
    let savedChallenge: { id: string; email: string; codeProof: string; expiresAt: number } | null =
      null;
    const sessions = memorySessionStore();
    const app = createHttpApp(
      service,
      logger,
      {
        demoMode: false,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: async (userId) => (userId === actor.id ? actor : null),
        resolveEmail: async (email) => (email === "organizer@greenroom.test" ? actor : null),
        sendLoginCode: async (_email, code) => {
          deliveredCode = code;
        },
        saveLoginChallenge: async (challenge) => {
          savedChallenge = challenge;
        },
        consumeLoginChallenge: async (id, proof, now) => {
          const saved = savedChallenge;
          if (!saved || saved.id !== id || saved.codeProof !== proof || saved.expiresAt <= now)
            return null;
          savedChallenge = null;
          return saved.email;
        },
        sessions,
      },
      testCrm(),
    );
    const requested = await app.request("/api/auth/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "organizer@greenroom.test" }),
    });
    expect(requested.status).toBe(202);
    const challenge = ((await requested.json()) as { challenge: string }).challenge;
    const verified = await app.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, code: deliveredCode }),
    });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await app.request("/api/session", { headers: { cookie } })).status).toBe(200);
    const tokenRequest = JSON.stringify({ eventId: "00000000-0000-4000-8000-000000000001" });
    expect(
      (
        await app.request("/api/auth/tokens", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: tokenRequest,
        })
      ).status,
    ).toBe(201);
    // A bearer that genuinely resolves, so the 401 below is the `authentication === "session"`
    // guard refusing it rather than the token failing to resolve for some other reason.
    sessions.seed({ id: "sid-token", userId: actor.id, issuedAt: 0, expiresAt: 2_000 });
    const bearer = await createEventToken(
      "sid-token",
      actor.id,
      "00000000-0000-4000-8000-000000000001",
      secret,
      2_000,
    );
    expect(
      (
        await app.request("/api/auth/tokens", {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: tokenRequest,
        })
      ).status,
    ).toBe(401);
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
        update: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        findById: vi.fn().mockResolvedValue(null),
        createOrganization: vi.fn(),
        findByProvisioningKey: vi.fn().mockResolvedValue(null),
        discardUnusedOrganization: vi.fn().mockResolvedValue(false),
        listIdsInOrganization: vi.fn().mockResolvedValue([]),
        listAllIdsInOrganization: vi.fn().mockResolvedValue([]),
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
        update: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        findById: vi.fn().mockResolvedValue(null),
        createOrganization: vi.fn(),
        findByProvisioningKey: vi.fn().mockResolvedValue(null),
        discardUnusedOrganization: vi.fn().mockResolvedValue(false),
        listIdsInOrganization: vi.fn().mockResolvedValue([]),
        listAllIdsInOrganization: vi.fn().mockResolvedValue([]),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // The public projection route is the one unauthenticated read that can reach a
    // repository, so it is where an anonymous 500 can be observed without demo mode.
    const app = createHttpAppFrom({
      events: service,
      logger,
      auth: { demoMode: false },
      publishing: {
        publicSnapshotBySlug: vi.fn().mockRejectedValue(new Error("storage unavailable")),
      } as unknown as PublicationService,
    });
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

  it("closes the emailed-code doors while the demo persona door is open", async () => {
    const { app } = createTestApp();
    // A demo deployment issues persona cookies and nothing else. Each of these routes refuses
    // before it parses a body or reads a session, so an unconfigured door is a door that is not
    // there rather than one that answers differently to different callers.
    for (const path of ["/api/auth/code", "/api/auth/verify", "/api/auth/tokens"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { ...(await cookieFor("organizer")), "content-type": "application/json" },
        body: JSON.stringify({ email: "organizer@greenroom.test" }),
      });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("offers the Google door only where it is configured, and reports which doors exist", async () => {
    const { app } = createTestApp();
    const unconfigured = await app.request("/api/auth/config");
    expect(authConfigResponseSchema.parse(await unconfigured.json())).toEqual({
      demoMode: true,
      google: false,
    });
    for (const path of ["/api/auth/google/start", "/api/auth/google/callback?code=c&state=s"])
      expect({ path, status: (await app.request(path)).status }).toEqual({ path, status: 404 });

    const google: GoogleAuthProvider = {
      start: async () => ({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
        attemptId: "attempt-1",
      }),
      // Every refusal of the protocol reaches the transport as `null`; the browser must not be
      // able to tell which one it was.
      complete: async () => ({ spentAttemptId: null, outcome: { status: "refused" } }),
      resolveUserActor: async () => null,
    };
    const configured = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
        google,
        sessions: memorySessionStore(),
      },
      testCrm(),
    );
    expect(
      authConfigResponseSchema.parse(await (await configured.request("/api/auth/config")).json()),
    ).toEqual({ demoMode: true, google: true });

    const started = await configured.request("/api/auth/google/start");
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
    );
    const attemptCookie = started.headers.get("set-cookie") ?? "";
    expect(attemptCookie).toContain("greenroom_oauth=attempt-1");
    expect(attemptCookie).toContain("HttpOnly");
    // Lax and not Strict: Google's return is a cross-site top-level navigation, and a Strict
    // cookie would not be sent on it.
    expect(attemptCookie).toContain("SameSite=Lax");

    // Nothing in the request decides where the browser goes next, whatever it supplies.
    const refused = await configured.request(
      "/api/auth/google/callback?code=c&state=s&returnTo=https://attacker.test",
      { headers: { cookie: "greenroom_oauth=attempt-1" } },
    );
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe("/signin?auth=failed");
    expect(refused.headers.get("set-cookie") ?? "").not.toContain("greenroom_session=");
  });

  /**
   * The success half of the callback, which the refusal case above cannot reach.
   *
   * It matters for two reasons that are invisible from the protocol tests: that a *real* session
   * cookie is issued — not a demo one — on a deployment whose `demoMode` is true, and that a
   * freshly provisioned account is sent somewhere that can welcome it while a returning one is
   * not.
   */
  it("issues a real session on a successful Google callback, and welcomes only a new account", async () => {
    const actor = await realOrganizer();
    const google = (provisioned: boolean): GoogleAuthProvider => ({
      start: async () => ({ authorizationUrl: "https://accounts.google.com/", attemptId: "a1" }),
      complete: async () => ({
        spentAttemptId: "a1",
        outcome: { status: "signed-in", actor, provisioned },
      }),
      resolveUserActor: async (userId) => (userId === actor.id ? actor : null),
    });
    const appFor = (provisioned: boolean) =>
      createHttpApp(
        new EventService({
          repository: new MemoryEventRepository(),
          newId: () => crypto.randomUUID(),
          now: () => new Date("2026-08-09T12:00:00.000Z"),
        }),
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        {
          demoMode: true,
          sessionSecret: secret,
          now: () => 1_000,
          resolveActor: resolveSeededDemoActor,
          google: google(provisioned),
          sessions: memorySessionStore(),
        },
        testCrm(),
      );

    const provisionedApp = appFor(true);
    const welcomed = await provisionedApp.request("/api/auth/google/callback?code=c&state=s", {
      headers: { cookie: "greenroom_oauth=a1" },
    });
    expect(welcomed.status).toBe(302);
    expect(welcomed.headers.get("location")).toBe("/?welcome=1");
    const issued = welcomed.headers.get("set-cookie") ?? "";
    expect(issued).toContain("greenroom_session=");
    expect(issued).toContain("HttpOnly");
    expect(issued).toContain("SameSite=Strict");
    // The attempt cookie is spent whatever the outcome, so a second callback has nothing to
    // present.
    expect(issued).toContain("greenroom_oauth=;");

    // The cookie it issued is a *user session* — two dot-separated parts — and resolves through
    // the real-session path rather than the persona path, which is the property that lets a
    // Google account and a demo persona share one deployment.
    const session = (issued.match(/greenroom_session=([^;]+)/) ?? [])[1] ?? "";
    expect(session.split(".")).toHaveLength(2);
    const read = await provisionedApp.request("/api/session", {
      headers: { cookie: `greenroom_session=${session}` },
    });
    expect(read.status).toBe(200);
    expect((await read.json()).actor.id).toBe(actor.id);

    const returning = await appFor(false).request("/api/auth/google/callback?code=c&state=s", {
      headers: { cookie: "greenroom_oauth=a1" },
    });
    expect(returning.headers.get("location")).toBe("/");
  });

  /**
   * Two tabs (issue #166).
   *
   * The provider here is the real thing's shape rather than a canned answer: it mints an attempt
   * per start, and `complete` succeeds only for a callback whose `state` names an attempt the
   * browser actually presented — which is exactly what `consumeOauthAttempt`'s
   * `id IN (…) AND state_proof = ?` does. That is what makes the assertions about *which* tab is
   * refused mean anything.
   */
  it("keeps every sign-in a browser started outstanding, and spends only the one that returns", async () => {
    const actor = await realOrganizer();
    const attempts = new Map<string, string>();
    let minted = 0;
    const google: GoogleAuthProvider = {
      start: async () => {
        minted += 1;
        const attemptId = `attempt-${minted}`;
        attempts.set(`state-${minted}`, attemptId);
        return {
          authorizationUrl: `https://accounts.google.com/?state=state-${minted}`,
          attemptId,
        };
      },
      complete: async ({ attemptIds, state }) => {
        const attemptId = attempts.get(state);
        if (!attemptId || !attemptIds.includes(attemptId))
          return { spentAttemptId: null, outcome: { status: "refused" } };
        attempts.delete(state);
        return {
          spentAttemptId: attemptId,
          outcome: { status: "signed-in", actor, provisioned: false },
        };
      },
      resolveUserActor: async (userId) => (userId === actor.id ? actor : null),
    };
    const app = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
        google,
        sessions: memorySessionStore(),
      },
      testCrm(),
    );
    // Two tabs, one after the other. The second start must not evict the first.
    const first = await app.request("/api/auth/google/start");
    const firstCookie = attemptCookieValue(first);
    const second = await app.request("/api/auth/google/start", {
      headers: { cookie: `greenroom_oauth=${firstCookie}` },
    });
    const bothCookie = attemptCookieValue(second);
    expect(bothCookie.split("~")).toEqual(["attempt-1", "attempt-2"]);

    // The *older* tab returns first — the ordering that used to refuse both. It signs in, and
    // the newer tab's attempt survives in the cookie it leaves behind.
    const older = await app.request("/api/auth/google/callback?code=c&state=state-1", {
      headers: { cookie: `greenroom_oauth=${bothCookie}` },
    });
    expect(older.headers.get("location")).toBe("/");
    expect(older.headers.get("set-cookie")).toContain("greenroom_session=");
    const afterOlder = attemptCookieValue(older);
    expect(afterOlder).toBe("attempt-2");

    // And the newer tab, arriving second, is signed in rather than refused.
    const newer = await app.request("/api/auth/google/callback?code=c&state=state-2", {
      headers: { cookie: `greenroom_oauth=${afterOlder}` },
    });
    expect(newer.headers.get("location")).toBe("/");
    expect(newer.headers.get("set-cookie")).toContain("greenroom_session=");
    // Nothing is left outstanding once both have returned.
    expect(newer.headers.get("set-cookie")).toContain("greenroom_oauth=;");
  });

  it("refuses a callback in a browser that started nothing, and leaves other tabs alone", async () => {
    const actor = await realOrganizer();
    const complete = vi.fn(async () => ({
      spentAttemptId: null,
      outcome: { status: "refused" as const },
    }));
    const app = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
        google: {
          start: async () => ({
            authorizationUrl: "https://accounts.google.com/",
            attemptId: "a1",
          }),
          complete,
          resolveUserActor: async (userId) => (userId === actor.id ? actor : null),
        },
        sessions: memorySessionStore(),
      },
      testCrm(),
    );

    // The browser-binding half of the CSRF defence: no cookie, no completion, and the provider
    // is never even asked — a forged callback cannot cost a token exchange.
    const stranger = await app.request("/api/auth/google/callback?code=c&state=whatever");
    expect(stranger.headers.get("location")).toBe("/signin?auth=failed");
    expect(stranger.headers.get("set-cookie") ?? "").not.toContain("greenroom_session=");
    expect(complete).not.toHaveBeenCalled();

    // A refused callback in a browser that *does* hold attempts spends none of them: the two
    // this browser started are still outstanding afterwards, which is what stops one tab's
    // failure from breaking the other's sign-in.
    const refused = await app.request("/api/auth/google/callback?code=c&state=forged", {
      headers: { cookie: "greenroom_oauth=attempt-1~attempt-2" },
    });
    expect(refused.headers.get("location")).toBe("/signin?auth=failed");
    expect(attemptCookieValue(refused)).toBe("attempt-1~attempt-2");
  });

  it("tells the person the deployment broke rather than blaming their sign-in", async () => {
    const actor = await realOrganizer();
    const app = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
        google: {
          start: async () => ({
            authorizationUrl: "https://accounts.google.com/",
            attemptId: "a1",
          }),
          // D1 unavailable, Google answering 5xx, provisioning failing part-way: the attempt is
          // spent, and the fault is ours (issue #164).
          complete: async () => ({
            spentAttemptId: "a1",
            outcome: { status: "unavailable" as const },
          }),
          resolveUserActor: async (userId) => (userId === actor.id ? actor : null),
        },
        sessions: memorySessionStore(),
      },
      testCrm(),
    );

    const broken = await app.request("/api/auth/google/callback?code=c&state=s", {
      headers: { cookie: "greenroom_oauth=a1~a2" },
    });
    expect(broken.headers.get("location")).toBe("/signin?auth=unavailable");
    // The spent attempt is dropped even though the sign-in failed; the other tab's is not.
    expect(attemptCookieValue(broken)).toBe("a2");
  });

  it("clears the session cookie on sign-out, whether or not one was presented", async () => {
    const { app } = createTestApp();
    const headers = await cookieFor("organizer");
    expect((await app.request("/api/session", { headers })).status).toBe(200);

    const signedOut = await app.request("/api/auth/signout", { method: "POST", headers });
    expect(signedOut.status).toBe(200);
    expect(signOutResponseSchema.parse(await signedOut.json())).toEqual({ signedOut: true });
    const cleared = signedOut.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("greenroom_session=;");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    // The cookie the browser is left holding resolves no session.
    expect(
      (await app.request("/api/session", { headers: { cookie: cleared.split(";")[0] ?? "" } }))
        .status,
    ).toBe(401);
    // Answering the same way with no session at all keeps this from reporting whether the
    // caller had one.
    const anonymous = await app.request("/api/auth/signout", { method: "POST" });
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toEqual({ signedOut: true });
  });
});
