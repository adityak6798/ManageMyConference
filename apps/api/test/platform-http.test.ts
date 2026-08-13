// @acceptance ACC-OPS

import {
  auditResponseSchema,
  inboxResponseSchema,
  searchResponseSchema,
} from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditRecordStore } from "../src/adapters/persistence/d1-audit-repository";
import { MemoryInboxDismissalStore } from "../src/adapters/persistence/d1-platform-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { CapabilityDeniedError } from "../src/application/identity/actor";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  AuditRecorder,
  createRequestIdentity,
  PlatformOperationsService,
  type PlatformSources,
} from "../src/application/platform/public";
import { createHttpAppFrom, type StructuredLogger } from "../src/transport/http/app";

const secret = "test-session-secret";
const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

const refuse = () => Promise.reject(new CapabilityDeniedError("Actor lacks the capability"));

/** Only what each route case needs; the service's own suite covers composition. */
function sources(overrides: Partial<PlatformSources> = {}): PlatformSources {
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
      organizerWorkspace: async () => ({
        proposals: [],
        assignments: [],
        evaluations: [],
        reviewerDirectory: [],
      }),
      reviewerQueue: async () => [
        {
          proposal: { id: "proposal-1", title: "Keynote proposal", abstract: "" },
          evaluation: null,
        },
      ],
    },
    agenda: { draft: refuse },
    publishing: { preview: refuse },
    communications: { history: refuse },
    crm: { list: refuse, listContacts: refuse },
    ...overrides,
  };
}

/** One derivable inbox item, so the dismissal routes have something real to name. */
const oneOpenTask = {
  content: {
    workspace: async () => ({
      sessions: [],
      speakers: [
        {
          id: "speaker-1",
          name: "Sam Speaker",
          email: "sam@example.test",
          bio: "",
          organization: "",
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Confirm profile details",
          status: "open",
          dueAt: "2026-08-20T23:59:00.000Z",
          speakerProfileId: "speaker-1",
        },
      ],
    }),
  },
} satisfies Partial<PlatformSources>;

const TASK_KEY = "speaker-task:task-1:2026-08-20T23:59:00.000Z";

function createTestApp(overrides: Partial<PlatformSources> = {}) {
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
    platformOps: new PlatformOperationsService({
      sources: sources(overrides),
      dismissals: new MemoryInboxDismissalStore(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    }),
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

describe("inbox HTTP transport", () => {
  it("refuses an anonymous caller and one without events:read on this event", async () => {
    const { app } = createTestApp(oneOpenTask);

    expect((await app.request(`/api/events/${EVENT_ONE}/inbox`)).status).toBe(401);
    expect(
      (
        await app.request(`/api/events/${EVENT_ONE}/inbox`, {
          headers: await cookieFor("public"),
        })
      ).status,
    ).toBe(403);
  });

  it("answers every category, marking the ones this role cannot read", async () => {
    const { app, logger } = createTestApp(oneOpenTask);
    const response = await app.request(`/api/events/${EVENT_ONE}/inbox`, {
      headers: await cookieFor("organizer"),
    });

    expect(response.status).toBe(200);
    const body = inboxResponseSchema.parse(await response.json());
    expect(body.categories.speakerWork).toMatchObject({
      state: "ok",
      items: [expect.objectContaining({ key: TASK_KEY, status: "open" })],
    });
    expect(body.categories.deliveries.state).toBe("unauthorized");
    expect(body.categories.publication.state).toBe("unauthorized");
    // An omitted category is the authorization model working, so nothing is logged for it.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("records a dismissal, shows it on the next read, and undoes it", async () => {
    const { app } = createTestApp(oneOpenTask);
    const headers = { ...(await cookieFor("organizer")), "content-type": "application/json" };

    const created = await app.request(`/api/events/${EVENT_ONE}/inbox/dismissals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ itemKey: TASK_KEY }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      dismissal: { itemKey: TASK_KEY, actorId: "seed-organizer" },
    });

    const dismissed = inboxResponseSchema.parse(
      await (
        await app.request(`/api/events/${EVENT_ONE}/inbox`, {
          headers: await cookieFor("organizer"),
        })
      ).json(),
    );
    expect(dismissed.categories.speakerWork).toMatchObject({
      state: "ok",
      items: [expect.objectContaining({ status: "dismissed" })],
    });

    const removed = await app.request(
      `/api/events/${EVENT_ONE}/inbox/dismissals/${encodeURIComponent(TASK_KEY)}`,
      { method: "DELETE", headers: await cookieFor("organizer") },
    );
    expect(removed.status).toBe(204);
    const restored = inboxResponseSchema.parse(
      await (
        await app.request(`/api/events/${EVENT_ONE}/inbox`, {
          headers: await cookieFor("organizer"),
        })
      ).json(),
    );
    expect(restored.categories.speakerWork).toMatchObject({
      state: "ok",
      items: [expect.objectContaining({ status: "open" })],
    });
  });

  it("answers 404 for a key this event is not showing, and 400 for a malformed body", async () => {
    const { app } = createTestApp(oneOpenTask);
    const headers = { ...(await cookieFor("organizer")), "content-type": "application/json" };

    const unknown = await app.request(`/api/events/${EVENT_ONE}/inbox/dismissals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ itemKey: "speaker-task:invented:2026-01-01T00:00:00.000Z" }),
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });

    const malformed = await app.request(`/api/events/${EVENT_ONE}/inbox/dismissals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ itemKey: "" }),
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { itemKey: expect.any(Array) } },
    });
  });

  it("treats undoing a dismissal that is not there as done", async () => {
    const { app } = createTestApp(oneOpenTask);

    const response = await app.request(
      `/api/events/${EVENT_ONE}/inbox/dismissals/${encodeURIComponent("nothing-here")}`,
      { method: "DELETE", headers: await cookieFor("organizer") },
    );

    expect(response.status).toBe(204);
  });

  it("validates the dismissal key carried by the DELETE path", async () => {
    const { app } = createTestApp(oneOpenTask);
    const response = await app.request(
      `/api/events/${EVENT_ONE}/inbox/dismissals/${"x".repeat(401)}`,
      { method: "DELETE", headers: await cookieFor("organizer") },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { itemKey: expect.any(Array) } },
    });
  });

  it("degrades one category to a correlated error and logs it once", async () => {
    const { app, logger } = createTestApp({
      ...oneOpenTask,
      agenda: { draft: () => Promise.reject(new Error("the board is unreachable")) },
    });
    const response = await app.request(`/api/events/${EVENT_ONE}/inbox`, {
      headers: { ...(await cookieFor("organizer")), "x-correlation-id": "inbox-degraded" },
    });

    const body = inboxResponseSchema.parse(await response.json());
    expect(body.categories.programme).toEqual({
      state: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        correlationId: "inbox-degraded",
      },
    });
    expect(body.categories.speakerWork.state).toBe("ok");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "inbox.programme" }),
      "request.exception",
    );
  });
});

describe("audit HTTP transport", () => {
  const auditFor = async (persona: "organizer" | "reviewer" | "public" | null, query = "") => {
    const store = new MemoryAuditRecordStore();
    const identity = createRequestIdentity();
    const audit = new AuditRecorder({
      store,
      identity,
      newId: () => "record-1",
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      report: vi.fn(),
    });
    await store.append({
      id: "record-seed",
      organizationId: ORGANIZATION,
      eventId: EVENT_ONE,
      occurredAt: "2026-08-12T09:00:00.000Z",
      actorId: "seed-organizer",
      actorName: "Olivia Organizer",
      source: "human",
      action: "review.reviewer_assigned",
      targetType: "review-round",
      targetId: "seed-reviewer:r1",
      correlationId: "corr-earlier",
      idempotencyKey: "audit:review.reviewer_assigned:seed-reviewer:r1",
    });
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
      platformOps: new PlatformOperationsService({
        sources: sources(),
        dismissals: new MemoryInboxDismissalStore(),
        now: () => new Date("2026-08-12T12:00:00.000Z"),
        audit,
        identity,
      }),
    });
    return app.request(
      `/api/events/${EVENT_ONE}/audit${query}`,
      persona ? { headers: await cookieFor(persona) } : {},
    );
  };

  it("refuses an anonymous caller and one without events:settings:read", async () => {
    expect((await auditFor(null)).status).toBe(401);
    expect((await auditFor("public")).status).toBe(403);
    // A reviewer holds `events:read` on this event and still may not read the log: it names who
    // did what, which is the organizer's administrative view rather than everybody's.
    expect((await auditFor("reviewer")).status).toBe(403);
  });

  it("answers an organizer with the record, and never with the idempotency key", async () => {
    const response = await auditFor("organizer");

    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const body = auditResponseSchema.parse(await response.json());
    expect(body.records).toEqual([
      {
        id: "record-seed",
        occurredAt: "2026-08-12T09:00:00.000Z",
        actorId: "seed-organizer",
        actorName: "Olivia Organizer",
        source: "human",
        action: "review.reviewer_assigned",
        targetType: "review-round",
        targetId: "seed-reviewer:r1",
        correlationId: "corr-earlier",
      },
    ]);
    expect(body.nextCursor).toBeNull();
    // The key is derived from the fact and is the one field a caller could use to guess at
    // records they were not shown.
    expect(text).not.toContain("idempotencyKey");
  });

  it("rejects a page size beyond the contract's maximum", async () => {
    const response = await auditFor("organizer", "?limit=500");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { limit: expect.any(Array) } },
    });
  });
});
