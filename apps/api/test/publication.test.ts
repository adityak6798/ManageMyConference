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
import type { Publication, PublicEventProjection } from "../src/domain/publishing/publication";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { CfpService } from "../src/application/cfp/cfp-service";
import type { ContentSession, SpeakerProfile } from "../src/domain/content/content";
import { createHttpApp } from "../src/transport/http/app";
import {
  publicEventProjectionSchema,
  publicScheduleSchema,
  type PublicScheduleDto,
} from "@greenroom/contracts";

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

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SAM = "10000000-0000-4000-8000-000000000001";
const JORDAN = "10000000-0000-4000-8000-000000000002";
const CALM_SESSION = "20000000-0000-4000-8000-000000000001";
const WORKSHOP_SESSION = "20000000-0000-4000-8000-000000000002";
const DRAFT_SESSION = "20000000-0000-4000-8000-000000000003";
const PUBLISHABLE_ASSET = "80000000-0000-4000-8000-000000000001";
const PRIVATE_ASSET = "80000000-0000-4000-8000-000000000002";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const speaker = (overrides: Partial<SpeakerProfile> & Pick<SpeakerProfile, "id" | "name">) => ({
  eventId: EVENT_ID,
  userId: `user-${overrides.id}`,
  sourcePersonId: `person-${overrides.id}`,
  email: `${overrides.id}@example.test`,
  bio: "",
  pronouns: "they/them",
  organization: "",
  ...overrides,
});
const session = (
  overrides: Partial<ContentSession> & Pick<ContentSession, "id" | "title" | "speakerProfileIds">,
): ContentSession => ({
  eventId: EVENT_ID,
  proposalId: `proposal-${overrides.id}`,
  abstract: "",
  format: "45-minute talk",
  tags: [],
  tracks: [],
  publicationState: "published",
  ...overrides,
});

/**
 * The composer wired to the real Memory repositories of every domain it reads from.
 *
 * The point of building it this way is that nothing here can hand `PublicationService` an
 * answer: content sessions, speaker profiles, publishable assets, the CFP snapshot and the
 * agenda publication are all produced by the same code that produces them in production,
 * so the join the composer performs is the thing under test.
 */
async function composedFixture() {
  const content = new MemoryContentRepository({
    sessions: [
      session({
        id: CALM_SESSION,
        title: "Designing the calm conference",
        abstract: "A practical guide to reducing operational noise.",
        speakerProfileIds: [SAM],
        tracks: ["Platform"],
      }),
      session({
        id: WORKSHOP_SESSION,
        title: "Accessible by default",
        abstract: "A hands-on guide to making conference experiences work for more attendees.",
        format: "60-minute workshop",
        speakerProfileIds: [JORDAN],
        tracks: ["Experience"],
      }),
      session({
        id: DRAFT_SESSION,
        title: "Still in draft",
        speakerProfileIds: [SAM],
        publicationState: "draft",
      }),
    ],
    speakers: [
      speaker({
        id: SAM,
        name: "Sam Speaker",
        bio: "Builds humane conference tools.",
        organization: "Greenroom Labs",
        photoAssetId: PRIVATE_ASSET,
      }),
      speaker({
        id: JORDAN,
        name: "Jordan Bell",
        bio: "Works with event teams on inclusive experiences.",
        organization: "Northwind Access",
        photoAssetId: PUBLISHABLE_ASSET,
      }),
    ],
    tasks: [],
    assets: [
      {
        id: PUBLISHABLE_ASSET,
        eventId: EVENT_ID,
        speakerProfileId: JORDAN,
        name: "jordan-bell-portrait.png",
        contentType: "image/png",
        storageKey: `${EVENT_ID}/${JORDAN}/${PUBLISHABLE_ASSET}`,
        visibility: "publishable",
        uploadedAt: "2026-08-10T17:00:00.000Z",
      },
      {
        id: PRIVATE_ASSET,
        eventId: EVENT_ID,
        speakerProfileId: SAM,
        name: "private-headshot.png",
        contentType: "image/png",
        storageKey: `${EVENT_ID}/${SAM}/${PRIVATE_ASSET}`,
        visibility: "private",
        uploadedAt: "2026-08-10T18:00:00.000Z",
      },
    ],
    messages: [],
  });
  const organizer = await resolveSeededDemoActor("organizer");
  const agendaRepository = new MemoryAgendaRepository([
    {
      eventId: EVENT_ID,
      rooms: [
        { id: "room-main", name: "Main stage" },
        { id: "room-lab", name: "Workshop lab" },
      ],
      tracks: [
        { id: "track-platform", name: "Platform", color: "#6257d9" },
        { id: "track-practice", name: "Practice", color: "#16866b" },
      ],
      slots: [
        {
          id: "slot-0900",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
        },
        {
          id: "slot-day2",
          startsAt: "2026-09-02T16:00:00.000Z",
          endsAt: "2026-09-02T17:00:00.000Z",
        },
      ],
      sessions: [],
      placements: [
        {
          id: "placement-opening",
          sessionId: CALM_SESSION,
          roomId: "room-main",
          trackId: "track-platform",
          slotId: "slot-0900",
        },
      ],
    },
  ]);
  const agenda = new AgendaService(
    agendaRepository,
    () => new Date("2026-08-10T20:00:00.000Z"),
    content,
  );
  await agenda.publish(organizer, EVENT_ID);

  const cfpRepository = new MemoryCfpRepository();
  await cfpRepository.savePublished(
    {
      eventId: EVENT_ID,
      title: "Share your conference story",
      description: "Submit a practical session for Greenroom Demo Summit.",
      fields: [{ id: "title", type: "short_text", label: "Proposal title", required: true }],
      status: "open",
      version: 1,
      publishedAt: "2026-08-09T12:00:00.000Z",
    } as never,
    true,
  );
  const cfp = new CfpService(
    cfpRepository,
    () => crypto.randomUUID(),
    () => new Date(),
  );

  let record: Publication = {
    eventId: EVENT_ID,
    slug: "safe-event",
    state: "published",
    draft: safeProjection,
    published: safeProjection,
    publishedAt: "2026-08-01T00:00:00.000Z",
  };
  // Same visibility contract as `D1PublicationRepository`: only a published row is public,
  // and unpublishing drops the snapshot rather than merely flagging the row.
  const repository = {
    findPublicBySlug: async (slug: string) =>
      slug === record.slug && record.state === "published" ? record : null,
    findByEventId: async () => record,
    publish: async (_eventId: string, publishedAt: string, published: PublicEventProjection) => {
      record = { ...record, state: "published", publishedAt, published };
      return record;
    },
    unpublish: async () => {
      record = { ...record, state: "unpublished", published: null, publishedAt: null };
      return record;
    },
    get stored() {
      return record.published;
    },
  } satisfies PublicationRepository & { readonly stored: PublicEventProjection | null };

  const service = new PublicationService(
    repository,
    {
      event: async () => ({ name: "Composed Event", timezone: "America/Los_Angeles" }),
      cfp: async (eventId) => {
        const form = await cfp.getPublished(eventId);
        return {
          title: form.title,
          description: form.description,
          status: form.status === "closed" ? ("closed" as const) : ("open" as const),
          publishedAt: form.publishedAt,
        };
      },
      content,
      schedule: (eventId) => agenda.published(eventId),
    },
    () => new Date("2026-08-10T00:00:00.000Z"),
  );
  return { record, service, repository, content, agenda };
}

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
    const { record, service, repository, content } = await composedFixture();
    expect((await service.publicBySlug("safe-event"))?.event.name).toBe("Safe Event");
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, record.eventId);

    // Everything below is a join the composer has to perform: the title and abstract come
    // from `content_sessions`, the room and the clock from the agenda publication that
    // placed the session, the track from that placement's track, the speaker line from
    // `speaker_profiles`, and the headshot from a *publishable* speaker asset. Hand any of
    // those back to a stub and the assertions stop meaning anything.
    expect(repository.stored).toMatchObject({
      event: { name: "Composed Event", startsOn: "2026-09-01", endsOn: "2026-09-02" },
      cfp: { title: "Share your conference story", status: "open" },
      sessions: [
        {
          slug: "accessible-by-default",
          title: "Accessible by default",
          track: "Experience",
          speakerSlugs: ["jordan-bell"],
        },
        {
          slug: "designing-the-calm-conference",
          title: "Designing the calm conference",
          track: "Platform",
          room: "Main stage",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
          speakerSlugs: ["sam-speaker"],
        },
      ],
      speakers: [
        {
          slug: "jordan-bell",
          name: "Jordan Bell",
          organization: "Northwind Access",
          photoUrl: `/api/speaker-assets/${PUBLISHABLE_ASSET}`,
        },
        { slug: "sam-speaker", name: "Sam Speaker", organization: "Greenroom Labs" },
      ],
    });
    // A draft session and a private headshot are upstream state the public never sees.
    expect(JSON.stringify(repository.stored)).not.toMatch(/Still in draft|private-headshot/);
    // The composed snapshot is a valid public contract, not merely shaped like one.
    expect(publicEventProjectionSchema.safeParse(repository.stored).success).toBe(true);

    // Republishing byte-identical content must not move a single public URL.
    const first = repository.stored;
    await service.publish(organizer, record.eventId);
    expect(repository.stored).toEqual(first);

    // A retitled session moves its own slug and leaves its neighbour's alone.
    const renamed = await content.findSession(CALM_SESSION);
    if (!renamed) throw new Error("the fixture must seed the calm-conference session");
    await content.updateSession({ ...renamed, title: "Designing the calm conference, revisited" });
    await service.publish(organizer, record.eventId);
    expect(repository.stored?.sessions.map(({ slug }) => slug)).toEqual([
      "accessible-by-default",
      "designing-the-calm-conference-revisited",
    ]);
  });

  it("emits readable slugs that are unique within the event and never a storage id", async () => {
    const { record, service, repository, content } = await composedFixture();
    const organizer = await resolveSeededDemoActor("organizer");
    // Two sessions with the same title is the case a bare slugifier gets wrong.
    const duplicate = await content.findSession(WORKSHOP_SESSION);
    if (!duplicate) throw new Error("the fixture must seed the accessibility workshop");
    await content.updateSession({ ...duplicate, title: "Designing the calm conference" });
    await service.publish(organizer, record.eventId);

    const slugs = [
      record.slug,
      ...(repository.stored?.sessions ?? []).map(({ slug }) => slug),
      ...(repository.stored?.speakers ?? []).flatMap((speaker) => speaker.slug),
      ...(repository.stored?.sessions ?? []).flatMap(({ speakerSlugs }) => speakerSlugs),
    ];
    for (const slug of slugs) {
      expect(slug, `${slug} must be a route-safe slug`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(slug, `${slug} leaks a storage UUID into a public URL`).not.toMatch(UUID_PATTERN);
    }
    const sessionSlugs = (repository.stored?.sessions ?? []).map(({ slug }) => slug);
    expect(new Set(sessionSlugs).size).toBe(sessionSlugs.length);
    for (const slug of sessionSlugs) expect(slug).toMatch(/^designing-the-calm-conference-/);

    // The suffix is derived from the record, not from its position, so the slug a
    // duplicate is given survives republication.
    const afterCollision = repository.stored;
    await service.publish(organizer, record.eventId);
    expect(repository.stored).toEqual(afterCollision);
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
      // Server-assigned and globally unique, but readable: the event UUID is hashed into a
      // short discriminator rather than pasted into the address organizers share.
      slug: expect.stringMatching(/^brand-new-event-[a-z0-9]+$/),
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
          organization: "Builder",
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
    // A published projection may be stored by any cache and used by none without asking
    // first, so an unpublish is visible to every reader on their next read.
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
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
        speakers: [{ slug: "ada lovelace", name: "Ada", bio: "Bio", organization: "Pioneer" }],
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

  it("serves the public schedule by slug and retracts it when the event is unpublished", async () => {
    const { service, repository, agenda } = await composedFixture();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, EVENT_ID);
    const events = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const secret = "public-schedule-secret";
    const app = createHttpApp(
      events,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        demoMode: true,
        sessionSecret: secret,
        now: () => 1_000,
        resolveActor: resolveSeededDemoActor,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      agenda,
      undefined,
      service,
    );

    const slug = repository.stored?.event.slug ?? "";
    expect(slug).toBe("safe-event");
    const live = await app.request(`/api/public/events/${slug}/schedule`);
    expect(live.status).toBe(200);
    const liveBody = await live.text();
    const { schedule } = JSON.parse(liveBody) as { schedule: PublicScheduleDto };
    // The published projection's session, under the agenda publication in force: the same
    // public slug the event hub uses, the room and clock that placed it, and nothing the
    // organizer has not published.
    expect(schedule).toEqual({
      eventSlug: "safe-event",
      version: 1,
      publishedAt: "2026-08-10T20:00:00.000Z",
      sessions: [
        {
          slug: "designing-the-calm-conference",
          title: "Designing the calm conference",
          abstract: "A practical guide to reducing operational noise.",
          format: "45-minute talk",
          track: "Platform",
          speakerSlugs: ["sam-speaker"],
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
          room: "Main stage",
        },
      ],
    });
    // The contract is the boundary, so hold the body to it rather than to a shape.
    expect(publicScheduleSchema.safeParse(schedule).success).toBe(true);
    // Audit-only identity never crosses the public boundary.
    expect(liveBody).not.toMatch(/publishedBy/);
    // No storage identifier of any kind: not the event's, not a session's, not a
    // speaker profile's, and not the agenda's internal room/track/slot/placement keys.
    expect(liveBody).not.toMatch(UUID_PATTERN);
    expect(liveBody).not.toMatch(/room-main|track-platform|slot-0900|placement-opening/);

    // Cheap to embed, impossible to serve stale: every read revalidates, an unchanged
    // schedule costs a bodyless 304, and that 304 still carries the CORS header a
    // cross-origin embed needs to accept it.
    expect(live.headers.get("cache-control")).toBe("public, no-cache");
    const revalidated = await app.request(`/api/public/events/${slug}/schedule`, {
      headers: {
        origin: "https://conference.example",
        "if-none-match": live.headers.get("etag") ?? "",
      },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("access-control-allow-origin")).toBe("*");
    expect(revalidated.headers.get("cache-control")).toBe("public, no-cache");

    // The internal UUID was the address before; it must no longer resolve at all.
    expect((await app.request(`/api/public/events/${EVENT_ID}/schedule`)).status).toBe(404);

    const unknown = await app.request("/api/public/events/never-published/schedule");
    expect(unknown.status).toBe(404);
    const unknownBody = (await unknown.json()) as { error: { code: string; message: string } };

    await service.unpublish(organizer, EVENT_ID);
    const retracted = await app.request(`/api/public/events/${slug}/schedule`);
    expect(retracted.status).toBe(404);
    const retractedBody = (await retracted.json()) as { error: { code: string; message: string } };
    // Unpublished and never-published are indistinguishable to an anonymous reader.
    expect(retractedBody.error.code).toBe(unknownBody.error.code);
    expect(retractedBody.error.message).toBe(unknownBody.error.message);
  });

  it("keeps a session the organizer placed but never published off the public schedule", async () => {
    const { service, agenda } = await composedFixture();
    const organizer = await resolveSeededDemoActor("organizer");
    // The board is the organizer's workspace: a session whose content is still a draft is
    // schedulable, and here it is scheduled. Publishing the agenda freezes it into the
    // snapshot together with its `content_sessions` and `speaker_profiles` primary keys.
    await agenda.place(organizer, EVENT_ID, {
      id: "placement-draft",
      sessionId: DRAFT_SESSION,
      roomId: "room-lab",
      trackId: "track-practice",
      slotId: "slot-day2",
    });
    const published = await agenda.publish(organizer, EVENT_ID);
    expect(published.version).toBe(2);
    expect(JSON.stringify(published)).toMatch(/Still in draft/);
    await service.publish(organizer, EVENT_ID);

    const app = createHttpApp(
      new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { demoMode: false },
      undefined,
      undefined,
      undefined,
      undefined,
      agenda,
      undefined,
      service,
    );
    const response = await app.request("/api/public/events/safe-event/schedule");
    expect(response.status).toBe(200);
    const body = await response.text();
    const { schedule } = JSON.parse(body) as { schedule: PublicScheduleDto };
    // The agenda publication in force is version 2 — and none of the draft session it
    // carries reaches the public: not its title, not its id, not its speaker.
    expect(schedule.version).toBe(2);
    expect(schedule.sessions.map(({ slug }) => slug)).toEqual(["designing-the-calm-conference"]);
    expect(body).not.toMatch(/Still in draft/);
    expect(body).not.toMatch(UUID_PATTERN);
    expect(body).not.toMatch(/Workshop lab|placement-draft/);
  });
});
