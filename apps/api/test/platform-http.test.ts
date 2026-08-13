// @acceptance ACC-OPS

import { searchResponseSchema } from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { CapabilityDeniedError } from "../src/application/identity/actor";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  type PlatformSearchDependencies,
  PlatformOperationsService,
} from "../src/application/platform/public";
import { createHttpAppFrom, type StructuredLogger } from "../src/transport/http/app";

const secret = "test-session-secret";
const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

const refuse = () => Promise.reject(new CapabilityDeniedError("Actor lacks the capability"));

/** Only what each route case needs; the service's own suite covers composition. */
function sources(overrides: Partial<PlatformSearchDependencies> = {}): PlatformSearchDependencies {
  return {
    events: { organizationOf: async () => ORGANIZATION },
    content: {
      workspace: async () => ({
        sessions: [
          {
            id: "session-1",
            title: "Opening keynote",
            abstract: "",
            format: "talk",
            tracks: [],
          },
        ],
        speakers: [],
        tasks: [],
      }),
    },
    review: {
      organizerWorkspace: async () => ({ proposals: [] }),
      reviewerQueue: async () => [
        {
          proposal: { id: "proposal-1", title: "Keynote proposal", abstract: "" },
          evaluation: null,
        },
      ],
    },
    agenda: { draft: refuse },
    communications: { history: refuse },
    crm: { list: refuse, listContacts: refuse },
    ...overrides,
  };
}

function createTestApp(overrides: Partial<PlatformSearchDependencies> = {}) {
  const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createHttpAppFrom({
    events: new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    }),
    logger,
    auth: {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    platformOps: new PlatformOperationsService(sources(overrides)),
  });
  return { app, logger };
}

const cookieFor = async (persona: "organizer" | "reviewer" | "speaker" | "public") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
});

describe("search HTTP transport", () => {
  it("refuses an anonymous caller with the correlated envelope", async () => {
    const { app } = createTestApp();
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote`, {
      headers: { "x-correlation-id": "search-anonymous" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", correlationId: "search-anonymous" },
    });
  });

  it("refuses a caller who holds no events:read on this event", async () => {
    const { app } = createTestApp();
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote`, {
      headers: await cookieFor("public"),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("rejects a query below the minimum as a field-level validation failure", async () => {
    const { app } = createTestApp();
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=k`, {
      headers: await cookieFor("organizer"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { q: expect.any(Array) } },
    });
  });

  it("rejects a malformed event id before reading any source", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/events/not-a-uuid/search?q=keynote", {
      headers: await cookieFor("organizer"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { eventId: expect.any(Array) } },
    });
  });

  it("answers a reviewer with the sections their role includes and marks the rest omitted", async () => {
    const { app, logger } = createTestApp({ content: { workspace: refuse } });
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote`, {
      headers: await cookieFor("reviewer"),
    });

    expect(response.status).toBe(200);
    const body = searchResponseSchema.parse(await response.json());
    expect(body.sections.review.state).toBe("ok");
    expect(body.sections.content.state).toBe("unauthorized");
    expect(body.sections.crm.state).toBe("unauthorized");
    // An omitted section is the authorization model working, so nothing is logged for it.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("degrades one section to a correlated error and logs it once", async () => {
    const { app, logger } = createTestApp({
      communications: { history: () => Promise.reject(new Error("history is unreachable")) },
    });
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote`, {
      headers: { ...(await cookieFor("organizer")), "x-correlation-id": "search-degraded" },
    });

    expect(response.status).toBe(200);
    const body = searchResponseSchema.parse(await response.json());
    expect(body.sections.communications).toEqual({
      state: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        correlationId: "search-degraded",
      },
    });
    expect(body.sections.content.state).toBe("ok");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "search.communications" }),
      "request.exception",
    );
  });

  it("never returns the internal rejection to the caller", async () => {
    const { app } = createTestApp({
      communications: {
        history: () => Promise.reject(new Error("password=hunter2 in the connection string")),
      },
    });
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote`, {
      headers: await cookieFor("organizer"),
    });

    expect(await response.text()).not.toContain("hunter2");
  });

  it("caps the requested limit at the contract's maximum", async () => {
    const { app } = createTestApp();
    const response = await app.request(`/api/events/${EVENT_ONE}/search?q=keynote&limit=500`, {
      headers: await cookieFor("organizer"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { limit: expect.any(Array) } },
    });
  });
});
