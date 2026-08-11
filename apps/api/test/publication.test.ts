// @acceptance ACC-PUBLIC
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import { PublicationService } from "../src/application/publishing/publication-service";
import type { Publication } from "../src/domain/publishing/publication";
import { createHttpApp } from "../src/transport/http/app";
import { publicEventProjectionSchema } from "@greenroom/contracts";

const safeProjection = {
  event: {
    eventId: "00000000-0000-4000-8000-000000000001",
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
    status: "open" as const,
    publishedAt: "2026-08-01T00:00:00.000Z",
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
    const organizer = await resolveSeededDemoActor("organizer");
    await expect(service.preview(null, record.eventId)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    await expect(
      service.publish(await resolveSeededDemoActor("reviewer"), record.eventId),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await service.unpublish(organizer, record.eventId);
    expect(await service.publicBySlug("safe-event")).toBeNull();
    await service.publish(organizer, record.eventId);
    expect((await service.publicBySlug("safe-event"))?.event.summary).toBe("PRIVATE DRAFT EDIT");
  });

  it("composes owning-domain public interfaces only when previewing or republishing", async () => {
    let record: Publication = {
      eventId: "00000000-0000-4000-8000-000000000001",
      slug: "safe-event",
      state: "published",
      draft: safeProjection,
      published: safeProjection,
      publishedAt: "2026-08-01T00:00:00.000Z",
    };
    const repository: PublicationRepository = {
      findPublicBySlug: vi.fn(async () => record),
      findByEventId: vi.fn(async () => record),
      publish: vi.fn(async (_eventId, publishedAt, published) => {
        record = { ...record, state: "published", publishedAt, published };
        return record;
      }),
      unpublish: vi.fn(async () => record),
    };
    const service = new PublicationService(
      repository,
      {
        event: vi.fn(async () => ({ name: "Composed Event", timezone: "America/Los_Angeles" })),
        cfp: vi.fn(async () => ({
          title: "Owned CFP",
          description: "From the CFP snapshot",
          status: "closed" as const,
          publishedAt: "2026-08-09T12:00:00.000Z",
        })),
        content: {
          publishedEventContent: vi.fn(async () => ({
            sessions: [
              {
                id: "session-one",
                title: "Owned session",
                abstract: "Accepted content",
                format: "talk",
                speakerProfileIds: ["speaker-one"],
                tags: [],
                tracks: [],
              },
            ],
            speakers: [
              {
                id: "speaker-one",
                name: "Owned speaker",
                bio: "Public bio",
                pronouns: "they/them",
                organization: "Greenroom",
              },
            ],
            assets: [],
          })),
        },
        schedule: vi.fn(async () => ({
          eventId: record.eventId,
          version: 1,
          publishedAt: "2026-08-09T13:00:00.000Z",
          agenda: {
            eventId: record.eventId,
            rooms: [{ id: "room-one", name: "Main stage" }],
            tracks: [{ id: "track-one", name: "Platform", color: "#000000" }],
            slots: [
              {
                id: "slot-one",
                startsAt: "2026-09-01T16:00:00.000Z",
                endsAt: "2026-09-01T17:00:00.000Z",
              },
            ],
            sessions: [],
            placements: [
              {
                id: "placement-one",
                sessionId: "session-one",
                roomId: "room-one",
                trackId: "track-one",
                slotId: "slot-one",
              },
            ],
          },
        })),
      },
      () => new Date("2026-08-10T00:00:00.000Z"),
    );
    expect((await service.publicBySlug("safe-event"))?.event.name).toBe("Safe Event");
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, record.eventId);
    expect(record.published).toMatchObject({
      event: { name: "Composed Event", startsOn: "2026-09-01" },
      cfp: { title: "Owned CFP", status: "closed" },
      sessions: [{ slug: "session-one", track: "Platform", room: "Main stage" }],
      speakers: [{ slug: "speaker-one", name: "Owned speaker" }],
    });
  });

  it("creates a publication lazily for a newly created event", async () => {
    let stored: Publication | null = null;
    const repository: PublicationRepository = {
      findPublicBySlug: vi.fn(async () => stored),
      findByEventId: vi.fn(async () => stored),
      publish: vi.fn(async (eventId, publishedAt, projection) => {
        stored = {
          eventId,
          slug: projection.event.slug,
          state: "published",
          draft: projection,
          published: projection,
          publishedAt,
        };
        return stored;
      }),
      unpublish: vi.fn(async () => stored),
    };
    const service = new PublicationService(repository, {
      event: vi.fn(async () => ({ name: "Brand New Event", timezone: "UTC" })),
      cfp: vi.fn(async () => null),
      content: {
        publishedEventContent: vi.fn(async () => ({ sessions: [], speakers: [], assets: [] })),
      },
      schedule: vi.fn(async () => null),
    });
    const organizer = await resolveSeededDemoActor("organizer");
    const preview = await service.preview(organizer, safeProjection.event.eventId);
    expect(preview).toMatchObject({
      state: "draft",
      slug: `brand-new-event-${safeProjection.event.eventId}`,
      draft: { event: { name: "Brand New Event", timezone: "UTC" } },
    });
    await expect(service.publish(organizer, safeProjection.event.eventId)).resolves.toMatchObject({
      state: "published",
      published: { event: { name: "Brand New Event" } },
    });
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
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ projection: { event: { name: "Safe Event" } } });
    expect(JSON.stringify(body)).not.toMatch(/private-org|crmNotes|private@example.com/);
    expect((await app.request("/api/public/events/unknown-event")).status).toBe(404);
  });

  it("rejects route-unsafe slugs and invalid event timezones", () => {
    expect(
      publicEventProjectionSchema.safeParse({
        ...safeProjection,
        event: { ...safeProjection.event, timezone: "Not/A_Zone" },
      }).success,
    ).toBe(false);
    expect(
      publicEventProjectionSchema.safeParse({
        ...safeProjection,
        speakers: [{ slug: "ada lovelace", name: "Ada", bio: "Bio", headline: "Pioneer" }],
      }).success,
    ).toBe(false);
    expect(
      publicEventProjectionSchema.safeParse({
        ...safeProjection,
        sessions: [
          {
            slug: "path/segment",
            title: "Session",
            abstract: "Abstract",
            format: "Talk",
            track: "Code",
            speakerSlugs: [],
          },
        ],
      }).success,
    ).toBe(false);
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
