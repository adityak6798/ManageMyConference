// @acceptance ACC-PUBLIC
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import { PublicationService } from "../src/application/publishing/publication-service";
import type { Publication } from "../src/domain/publishing/publication";
import { createHttpApp } from "../src/transport/http/app";

const safeProjection = {
  event: {
    slug: "safe-event",
    name: "Safe Event",
    summary: "Public",
    startsOn: "2026-09-01",
    endsOn: "2026-09-02",
    timezone: "UTC",
    venue: "Online",
  },
  cfp: {
    title: "CFP",
    description: "Join",
    opensAt: "2026-08-01T00:00:00.000Z",
    closesAt: "2026-08-20T00:00:00.000Z",
    submissionUrl: "https://example.com/cfp",
  },
  sessions: [],
  speakers: [],
};

describe("publication snapshots", () => {
  it("serves only the immutable published snapshot and hides unpublished events", async () => {
    let record: Publication = {
      eventId: "00000000-0000-4000-8000-000000000001",
      slug: "safe-event",
      state: "published",
      draft: {
        ...safeProjection,
        event: { ...safeProjection.event, summary: "PRIVATE DRAFT EDIT" },
      },
      published: safeProjection,
      publishedAt: "2026-08-01T00:00:00.000Z",
    };
    const repository: PublicationRepository = {
      findPublicBySlug: vi.fn(async () => (record.state === "published" ? record : null)),
      findByEventId: vi.fn(async () => record),
      publish: vi.fn(
        async (_id, publishedAt, projection) =>
          (record = { ...record, state: "published", published: projection, publishedAt }),
      ),
      unpublish: vi.fn(
        async () =>
          (record = { ...record, state: "unpublished", published: null, publishedAt: null }),
      ),
    };
    const service = new PublicationService(repository, () => new Date("2026-08-10T00:00:00.000Z"));
    expect((await service.publicBySlug("safe-event"))?.event.summary).toBe("Public");
    await service.unpublish(record.eventId);
    expect(await service.publicBySlug("safe-event")).toBeNull();
    await service.publish(record.eventId);
    expect((await service.publicBySlug("safe-event"))?.event.summary).toBe("PRIVATE DRAFT EDIT");
  });

  it("returns an unauthenticated allowlisted API projection without private source fields", async () => {
    const leakedSource = {
      ...safeProjection,
      event: { ...safeProjection.event, organizationId: "private-org" },
      crmNotes: "never public",
      speakers: [
        {
          slug: "speaker",
          name: "Speaker",
          headline: "Builder",
          bio: "Public bio",
          privateEmail: "private@example.com",
        },
      ],
    };
    const publication: Publication = {
      eventId: "00000000-0000-4000-8000-000000000001",
      slug: "safe-event",
      state: "published",
      draft: leakedSource,
      published: leakedSource,
      publishedAt: "2026-08-01T00:00:00.000Z",
    };
    const repository: PublicationRepository = {
      findPublicBySlug: vi.fn(async (slug) => (slug === publication.slug ? publication : null)),
      findByEventId: vi.fn(async () => publication),
      publish: vi.fn(async () => publication),
      unpublish: vi.fn(async () => publication),
    };
    const events = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const app = createHttpApp(
      events,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { demoMode: false },
      new PublicationService(repository),
    );

    const response = await app.request("/api/public/events/safe-event");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");
    const body = await response.json();
    expect(body).toMatchObject({ projection: { event: { name: "Safe Event" } } });
    expect(JSON.stringify(body)).not.toMatch(/private-org|crmNotes|private@example.com/);
    expect((await app.request("/api/public/events/unknown-event")).status).toBe(404);
  });

  it("requires organizer event scope for preview and publication mutations", async () => {
    let publication: Publication = {
      eventId: "00000000-0000-4000-8000-000000000001",
      slug: "safe-event",
      state: "draft",
      draft: safeProjection,
      published: null,
      publishedAt: null,
    };
    const repository: PublicationRepository = {
      findPublicBySlug: vi.fn(async () => null),
      findByEventId: vi.fn(async (eventId) =>
        eventId === publication.eventId ? publication : null,
      ),
      publish: vi.fn(
        async (_id, publishedAt, projection) =>
          (publication = {
            ...publication,
            state: "published",
            publishedAt,
            published: projection,
          }),
      ),
      unpublish: vi.fn(async () => publication),
    };
    const events = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const secret = "publication-route-secret";
    const app = createHttpApp(
      events,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      new PublicationService(repository, () => new Date("2026-08-10T00:00:00.000Z")),
    );
    const cookie = async (persona: "organizer" | "reviewer") => ({
      cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
    });
    const path = `/api/publishing/events/${publication.eventId}/preview`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: await cookie("reviewer") })).status).toBe(403);
    expect((await app.request(path, { headers: await cookie("organizer") })).status).toBe(200);
    expect(
      (
        await app.request("/api/publishing/events/00000000-0000-4000-8000-000000000099/preview", {
          headers: await cookie("organizer"),
        })
      ).status,
    ).toBe(404);
    const published = await app.request(`/api/publishing/events/${publication.eventId}/publish`, {
      method: "POST",
      headers: await cookie("organizer"),
    });
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({ publication: { state: "published" } });
  });
});
