// @acceptance ACC-PUBLIC ACC-AGENDA
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import {
  type D1CfpDatabasePort,
  D1CfpRepository,
} from "../src/adapters/persistence/d1-cfp-repository";
import { D1ContentRepository } from "../src/adapters/persistence/d1-content-repository";
import { D1EventRepository } from "../src/adapters/persistence/d1-event-repository";
import { D1PublicationRepository } from "../src/adapters/persistence/d1-publication-repository";
import { D1ReviewRepository } from "../src/adapters/persistence/d1-review-repository";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import { D1ItineraryRepository } from "../src/adapters/persistence/d1-itinerary-repository";
import { D1SubmittedProposalAdapter } from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { R2AssetStorage, type R2BucketPort } from "../src/adapters/storage/r2-asset-storage";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { CfpService, CfpUnavailableError } from "../src/application/cfp/cfp-service";
import { ContentService } from "../src/application/content/content-service";
import { EventService } from "../src/application/events/event-service";
import { ReviewService } from "../src/application/review/review-service";
import {
  PublicationProjectionConflictError,
  PublicationService,
  PublicationSlugTakenError,
} from "../src/application/publishing/publication-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";
import { publishingRoutes } from "../src/transport/http/routes/publishing";
import { applyMigrations, applySeed, applySeedData, seededAssetBytes } from "./support/seeded-d1";

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const DEMO_SLUG = "greenroom-demo-summit";
const SEEDED_HEADSHOT = "90000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const safeProjection = {
  event: {
    eventId: DEMO_EVENT,
    slug: "safe-event",
    name: "Safe Event",
    summary: "Public summary",
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

/**
 * The production wiring of `PublicationService`, assembled the way `src/index.ts` assembles
 * it. Composing through the real D1 repositories is what makes "the seed is what publish
 * produces" a checkable property rather than a claim about a hand-written blob.
 */
function publishingFor(database: never) {
  const identities = new D1IdentityDirectory(database);
  const events = new EventService({
    repository: new D1EventRepository(database),
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  const contentRepository = new D1ContentRepository(database);
  const cfpService = new CfpService(
    new D1CfpRepository(database as unknown as D1CfpDatabasePort),
    () => crypto.randomUUID(),
    () => new Date(),
  );
  const publicationRepository = new D1PublicationRepository(database);
  let publishing: PublicationService;
  const agenda: AgendaService = new AgendaService(
    new D1AgendaRepository(
      database,
      () => new Date("2026-08-10T20:00:00.000Z"),
      async (_database, event, schedule) => {
        const refresh = await publishing.prepareScheduleRefresh(event, schedule);
        return refresh ? publicationRepository.prepareRefreshStatements(refresh) : [];
      },
    ),
    () => new Date("2026-08-10T20:00:00.000Z"),
    contentRepository,
  );
  publishing = new PublicationService(
    publicationRepository,
    {
      event: async (actor, eventId) => {
        const event = await events.get(actor, eventId);
        return event ? { name: event.name, timezone: event.timezone } : null;
      },
      cfp: async (eventId) => {
        try {
          const form = await cfpService.getPublished(eventId);
          return {
            version: form.version,
            title: form.title,
            description: form.description,
            status: form.status === "closed" ? ("closed" as const) : ("open" as const),
            publishedAt: form.publishedAt,
          };
        } catch (error) {
          if (error instanceof CfpUnavailableError) return null;
          throw error;
        }
      },
      content: contentRepository,
      schedule: (eventId) => agenda.published(eventId),
    },
    () => new Date("2026-08-10T20:00:00.000Z"),
  );
  return {
    agenda,
    contentRepository,
    events,
    identities,
    publicationRepository,
    publishing,
  };
}

describe("D1PublicationRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("refuses a refresh result whose driver omits the affected-row count", async () => {
    const statement = {
      bind() {
        return this;
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
      async all() {
        return { success: true, results: [] };
      },
    };
    const repository = new D1PublicationRepository({
      prepare: () => statement,
      batch: async () => [{ success: true }, { success: true, meta: { changes: 1 } }],
    } as never);

    await expect(
      repository.refreshPublished({
        eventId: DEMO_EVENT,
        expectedProjectionVersion: 1,
        activatedAt: "2026-08-10T20:00:00.000Z",
        projection: safeProjection,
        provenance: {
          agendaVersion: 2,
          agendaPublishedAt: "2026-08-10T20:00:00.000Z",
          cfpVersion: 1,
          cfpPublishedAt: "2026-08-09T12:00:00.000Z",
          contentDigest: "fnv1a32:12345678",
          cause: "source-reconciled",
        },
      }),
    ).rejects.toThrow("D1 reported no row count while attempting to refresh public projection");
  });

  it("reports only the writer that actually transitions a published projection", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-unpublish-race" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const repository = new D1PublicationRepository(database);

    const [first, second] = await Promise.all([
      repository.unpublish(DEMO_EVENT),
      repository.unpublish(DEMO_EVENT),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter((result) => result === null)).toHaveLength(1);
  });

  it("refuses to migrate an existing live-to-draft slug collision", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-slug-migration-audit" },
    });
    const database = await runtime.getD1Database("DB");
    await applyMigrations(database, { through: "1801_itinerary_retention.sql" });
    await applySeedData(database);
    const otherDraft = {
      ...safeProjection,
      event: {
        ...safeProjection.event,
        eventId: "00000000-0000-4000-8000-000000000002",
        slug: DEMO_SLUG,
      },
    };
    await database
      .prepare(
        `INSERT INTO public_event_projections
          (event_id, slug, state, draft_json, published_json, published_at)
         VALUES (?, ?, 'draft', ?, NULL, NULL)`,
      )
      .bind(
        "00000000-0000-4000-8000-000000000002",
        "different-live-address",
        JSON.stringify(otherDraft),
      )
      .run();

    await expect(
      applyMigrations(database, {
        from: "1802_publication_slug_reservations.sql",
        through: "1802_publication_slug_reservations.sql",
      }),
    ).rejects.toThrow(/1802_publication_slug_reservations\.sql: statement \d+ failed/);
  });

  it("reserves a draft slug for published events when two writes race without a pre-check", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-slug-race" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const repository = new D1PublicationRepository(database);
    const projectionFor = (eventId: string, slug: string) => ({
      ...safeProjection,
      event: { ...safeProjection.event, eventId, slug },
    });
    const firstEvent = "00000000-0000-4000-8000-000000000002";
    const secondEvent = "00000000-0000-4000-8000-000000000099";

    await repository.publish(
      firstEvent,
      "2026-08-10T20:00:00.000Z",
      projectionFor(firstEvent, "first-live-address"),
    );
    await repository.publish(
      secondEvent,
      "2026-08-10T20:00:00.000Z",
      projectionFor(secondEvent, "second-live-address"),
    );

    await repository.saveSettings(
      firstEvent,
      "raced-address",
      projectionFor(firstEvent, "raced-address"),
    );
    const racedWrite = repository.saveSettings(
      secondEvent,
      "raced-address",
      projectionFor(secondEvent, "raced-address"),
    );
    await expect(racedWrite).rejects.toBeInstanceOf(PublicationSlugTakenError);
    // ERROR-INTENT: the assertion below inspects the rejected domain error's transport mapping.
    const error = await racedWrite.catch((reason: unknown) => reason);
    expect(publishingRoutes.translateError?.(error)).toMatchObject({
      code: "CONFLICT",
      status: 409,
      fields: { slug: ["That public address is already taken."] },
    });
  });

  it("prunes stale empty itineraries and plans whose event ended beyond the grace", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-itinerary-retention" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const itineraries = new D1ItineraryRepository(database);
    const old = "2026-08-01T00:00:00.000Z";
    const recent = "2026-08-20T09:00:00.000Z";
    await itineraries.create("a".repeat(64), DEMO_EVENT, [], old);
    await itineraries.create("b".repeat(64), DEMO_EVENT, [], recent);
    await itineraries.create(
      "c".repeat(64),
      "00000000-0000-4000-8000-000000000002",
      ["saved-session"],
      recent,
    );
    const ended = { ...safeProjection, event: { ...safeProjection.event, endsOn: "2026-08-18" } };
    await new D1PublicationRepository(database).saveSettings(
      "00000000-0000-4000-8000-000000000002",
      "ended-event",
      ended,
    );

    await itineraries.prune("2026-08-19T10:00:00.000Z", "2026-08-19");

    await expect(itineraries.findByTokenHash("a".repeat(64))).resolves.toBeNull();
    await expect(itineraries.findByTokenHash("b".repeat(64))).resolves.not.toBeNull();
    await expect(itineraries.findByTokenHash("c".repeat(64))).resolves.toBeNull();
  });

  it("stores only allowlisted fields when publishing a contaminated draft", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-test" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const draft = {
      ...safeProjection,
      crmNotes: "private CRM",
      speakers: [
        {
          slug: "speaker",
          name: "Speaker",
          bio: "Public",
          organization: "Builder",
          privateEmail: "private@example.com",
        },
      ],
    };
    await database
      .prepare(
        "UPDATE public_event_projections SET state = 'draft', draft_json = ?, published_json = NULL, published_at = NULL WHERE event_id = ?",
      )
      .bind(JSON.stringify(draft), DEMO_EVENT)
      .run();
    const service = new PublicationService(
      new D1PublicationRepository(database),
      () => new Date("2026-08-10T00:00:00.000Z"),
    );
    await service.publish(await resolveSeededDemoActor("organizer"), DEMO_EVENT);
    const stored = await database
      .prepare("SELECT published_json FROM public_event_projections WHERE event_id = ?")
      .bind(DEMO_EVENT)
      .first<{ published_json: string }>();
    expect(stored).not.toBeNull();
    expect(stored?.published_json).not.toMatch(
      /crmNotes|private CRM|privateEmail|private@example.com/,
    );
    expect(JSON.parse(stored?.published_json ?? "{}")).toMatchObject({
      event: { name: "Safe Event" },
      speakers: [{ name: "Speaker" }],
    });
  });

  /*
   * The seed used to ship a hand-written `published_json` naming sessions and speakers that
   * existed in no other table, so the public page and the organizer workspace showed
   * unrelated events and pressing Publish destroyed the nicer half. This asserts the seed is
   * the output of the real composer over the real seeded CFP, content and agenda.
   */
  it("seeds a published projection identical to what the publish command recomposes", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-seed-parity" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { publishing, publicationRepository } = publishingFor(database as never);

    const seeded = await publicationRepository.findPublicBySlug(DEMO_SLUG);
    if (!seeded?.published) throw new Error(`the seed must publish ${DEMO_SLUG}`);
    const organizer = await resolveSeededDemoActor("organizer");
    const preview = await publishing.preview(organizer, DEMO_EVENT);
    if (!preview) throw new Error("an organizer must be able to preview the seeded event");

    // `published == preview` on a fresh reset: Publish is a no-op on the seeded demo.
    expect(preview.draft).toEqual(seeded.published);
    expect(preview.draft).toEqual(seeded.draft);

    // The page shows the workspace: the accepted sessions and their speaker profiles.
    expect(preview.draft.sessions.map(({ title }) => title)).toEqual([
      "Accessible by default",
      "Designing the calm conference",
    ]);
    expect(preview.draft.speakers.map(({ name }) => name)).toEqual(["Jordan Bell", "Sam Speaker"]);
    expect(preview.draft.speakers.find(({ name }) => name === "Jordan Bell")?.photoUrl).toBe(
      `/api/speaker-assets/${SEEDED_HEADSHOT}`,
    );

    // No public URL anywhere in the snapshot is a storage id.
    for (const slug of [
      seeded.slug,
      seeded.published.event.slug,
      ...seeded.published.sessions.flatMap((item) => [item.slug, ...item.speakerSlugs]),
      ...seeded.published.speakers.map(({ slug: value }) => value),
    ]) {
      expect(slug, `${slug} must be route-safe`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(slug, `${slug} leaks a storage UUID`).not.toMatch(UUID_PATTERN);
    }

    // Publishing from the clean seed leaves the public page exactly as it was.
    await publishing.publish(organizer, DEMO_EVENT);
    const republished = await publicationRepository.findPublicBySlug(DEMO_SLUG);
    expect(republished?.published).toEqual(seeded.published);
  });

  it("recomposes an event rename into the draft and waits for publish before changing public", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-event-rename" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { events, publicationRepository, publishing } = publishingFor(database as never);
    const organizer = await resolveSeededDemoActor("organizer");
    const before = await publicationRepository.findPublicBySlug(DEMO_SLUG);

    await events.update(organizer, DEMO_EVENT, {
      name: "Greenroom Renamed Summit",
      timezone: "America/New_York",
    });

    const preview = await publishing.preview(organizer, DEMO_EVENT);
    expect(preview?.draft.event).toMatchObject({
      name: "Greenroom Renamed Summit",
      timezone: "America/New_York",
      slug: DEMO_SLUG,
    });
    expect(
      (await publicationRepository.findPublicBySlug(DEMO_SLUG))?.published?.event,
    ).toMatchObject({
      name: before?.published?.event.name,
      timezone: before?.published?.event.timezone,
      slug: DEMO_SLUG,
    });

    await publishing.publish(organizer, DEMO_EVENT);
    expect(
      (await publicationRepository.findPublicBySlug(DEMO_SLUG))?.published?.event,
    ).toMatchObject({
      name: "Greenroom Renamed Summit",
      timezone: "America/New_York",
      slug: DEMO_SLUG,
    });
  });

  it("publishes an agenda and advances the live projection in the same durable write", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-agenda-refresh" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { agenda, events, publicationRepository, publishing } = publishingFor(database as never);
    const organizer = await resolveSeededDemoActor("organizer");
    const app = createHttpApp(
      events,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { demoMode: false },
      undefined,
      undefined,
      undefined,
      undefined,
      agenda,
      undefined,
      publishing,
    );

    // Read the seeded live snapshot, then move the second day's session to a later hour.
    expect((await app.request(`/api/public/events/${DEMO_SLUG}`)).status).toBe(200);
    const draft = await agenda.draft(organizer, DEMO_EVENT);
    await agenda.configure(organizer, DEMO_EVENT, {
      rooms: draft.rooms,
      tracks: draft.tracks,
      slots: draft.slots.map((slot) =>
        slot.id === "slot-day-two"
          ? {
              ...slot,
              startsAt: "2026-09-02T19:00:00.000Z",
              endsAt: "2026-09-02T20:00:00.000Z",
            }
          : slot,
      ),
    });
    await agenda.publish(organizer, DEMO_EVENT, "projection-refresh-v2");

    const hub = await app.request(`/api/public/events/${DEMO_SLUG}`);
    expect(hub.status).toBe(200);
    const hubBody = (await hub.json()) as {
      projection: { sessions: Array<Record<string, unknown>> };
      publication: { version: number; provenance: { agendaVersion: number } };
    };
    expect(
      hubBody.projection.sessions.find(({ title }) => title === "Accessible by default"),
    ).toMatchObject({
      startsAt: "2026-09-02T19:00:00.000Z",
      endsAt: "2026-09-02T20:00:00.000Z",
      room: "Workshop lab",
      track: "Practice",
    });
    expect(hubBody.publication).toMatchObject({
      provenance: { agendaVersion: 2 },
    });

    const schedule = await app.request(`/api/public/events/${DEMO_SLUG}/schedule`);
    expect(schedule.status).toBe(200);
    const scheduleBody = (await schedule.json()) as {
      schedule: { version: number; sessions: Array<Record<string, unknown>> };
    };
    expect(scheduleBody.schedule.version).toBe(2);
    expect(
      [...scheduleBody.schedule.sessions].sort((left, right) =>
        String(left.title).localeCompare(String(right.title)),
      ),
    ).toEqual(
      hubBody.projection.sessions
        .filter(({ startsAt }) => Boolean(startsAt))
        .sort((left, right) => String(left.title).localeCompare(String(right.title))),
    );

    const history = await database
      .prepare(
        "SELECT version, agenda_version, activation_cause FROM public_event_projection_versions WHERE event_id = ? ORDER BY version",
      )
      .bind(DEMO_EVENT)
      .all<{ version: number; agenda_version: number | null; activation_cause: string }>();
    expect(history.results?.at(-1)).toMatchObject({
      agenda_version: 2,
      activation_cause: "schedule-published",
    });
    expect(new Set(history.results?.map(({ version }: { version: number }) => version)).size).toBe(
      history.results?.length,
    );
    expect((await publicationRepository.findByEventId(DEMO_EVENT))?.projectionVersion).toBe(
      history.results?.at(-1)?.version,
    );
  });

  it("refuses a stale recomposition without overwriting a concurrent site publication", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-projection-cas" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { publicationRepository: repository, publishing } = publishingFor(database as never);
    await publishing.publicBySlug(DEMO_SLUG);
    const before = await repository.findByEventId(DEMO_EVENT);
    expect(before?.published).not.toBeNull();
    const expected = before?.projectionVersion ?? 0;
    const provenance = before?.provenance;
    expect(provenance).not.toBeNull();

    const explicit = {
      ...(before?.published ?? safeProjection),
      event: { ...(before?.published ?? safeProjection).event, summary: "Concurrent site edit" },
    };
    await repository.publish(
      DEMO_EVENT,
      "2026-08-10T21:00:00.000Z",
      explicit,
      provenance ?? undefined,
      expected,
    );

    await expect(
      repository.refreshPublished({
        eventId: DEMO_EVENT,
        expectedProjectionVersion: expected,
        activatedAt: "2026-08-10T21:01:00.000Z",
        projection: {
          ...(before?.published ?? safeProjection),
          event: { ...(before?.published ?? safeProjection).event, summary: "Stale bytes" },
        },
        provenance: provenance ?? {
          agendaVersion: null,
          agendaPublishedAt: null,
          cfpVersion: null,
          cfpPublishedAt: null,
          contentDigest: "legacy:unknown",
          cause: "source-reconciled",
        },
      }),
    ).rejects.toBeInstanceOf(PublicationProjectionConflictError);
    expect((await repository.findByEventId(DEMO_EVENT))?.published?.event.summary).toBe(
      "Concurrent site edit",
    );
  });

  it("classifies a second identical refresh as retryable contention", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-projection-convergent-cas" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { publicationRepository: repository, publishing } = publishingFor(database as never);
    await publishing.publicBySlug(DEMO_SLUG);
    const before = await repository.findByEventId(DEMO_EVENT);
    const expected = before?.projectionVersion ?? 0;
    const provenance = before?.provenance;
    expect(before?.published).not.toBeNull();
    expect(provenance).not.toBeNull();

    // Two anonymous readers can both compose these bytes from version N. Only one may activate
    // N+1; the other must become a retryable CAS conflict, never a history uniqueness fault.
    const refresh = {
      eventId: DEMO_EVENT,
      expectedProjectionVersion: expected,
      activatedAt: "2026-08-10T21:02:00.000Z",
      projection: {
        ...(before?.published ?? safeProjection),
        event: { ...(before?.published ?? safeProjection).event, summary: "Converged refresh" },
      },
      provenance: {
        ...(provenance ?? {
          agendaVersion: null,
          agendaPublishedAt: null,
          cfpVersion: null,
          cfpPublishedAt: null,
          contentDigest: "legacy:unknown",
          cause: "source-reconciled" as const,
        }),
        contentDigest: "fnv1a32:converged",
        cause: "source-reconciled" as const,
      },
    };
    const results = await Promise.allSettled([
      repository.refreshPublished(refresh),
      repository.refreshPublished(refresh),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const loser = results.find(({ status }) => status === "rejected");
    expect(loser).toMatchObject({
      status: "rejected",
      reason: expect.any(PublicationProjectionConflictError),
    });

    const active = await repository.findByEventId(DEMO_EVENT);
    expect(active?.projectionVersion).toBe(expected + 1);
    expect(active?.published?.event.summary).toBe("Converged refresh");
    const history = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM public_event_projection_versions WHERE event_id = ? AND version = ?",
      )
      .bind(DEMO_EVENT, expected + 1)
      .first<{ count: number }>();
    expect(history?.count).toBe(1);
  });

  it("enforces immutable projection history in storage", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-projection-history-immutable" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    await publishingFor(database as never).publishing.publicBySlug(DEMO_SLUG);
    await expect(
      database
        .prepare("UPDATE public_event_projection_versions SET activated_at = ? WHERE event_id = ?")
        .bind("2026-08-11T00:00:00.000Z", DEMO_EVENT)
        .run(),
    ).rejects.toThrow("public projection history is immutable");
    await expect(
      database
        .prepare("DELETE FROM public_event_projection_versions WHERE event_id = ?")
        .bind(DEMO_EVENT)
        .run(),
    ).rejects.toThrow("public projection history is immutable");
  });

  it("does not create a public projection when an unpublished event publishes its agenda", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-agenda-private-event" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const { agenda, publicationRepository, publishing } = publishingFor(database as never);
    const organizer = await resolveSeededDemoActor("organizer");
    await publishing.publicBySlug(DEMO_SLUG);
    const before = await database
      .prepare("SELECT COUNT(*) AS count FROM public_event_projection_versions WHERE event_id = ?")
      .bind(DEMO_EVENT)
      .first<{ count: number }>();
    await publicationRepository.unpublish(DEMO_EVENT);

    await agenda.publish(organizer, DEMO_EVENT, "private-agenda-v2");

    await expect(publicationRepository.findPublicBySlug(DEMO_SLUG)).resolves.toBeNull();
    const history = await database
      .prepare("SELECT COUNT(*) AS count FROM public_event_projection_versions WHERE event_id = ?")
      .bind(DEMO_EVENT)
      .first<{ count: number }>();
    expect(history?.count).toBe(before?.count);
    expect(history?.count).toBeGreaterThan(0);
  });

  it("serves the seeded headshot to an anonymous reader and withdraws it on unpublish", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "publishing-seed-assets" },
      r2Buckets: { ASSETS: "publishing-seed-assets-bucket" },
    });
    const database = await runtime.getD1Database("DB");
    await applySeed(database);
    const bytes = await seededAssetBytes();
    const { agenda, contentRepository, events, publicationRepository, publishing } = publishingFor(
      database as never,
    );
    // Where the bytes live is content's record to hand over, not a table publishing reads.
    const seededAsset = await contentRepository.findAsset(SEEDED_HEADSHOT);
    expect(seededAsset?.storageKey, "the seed must record where the headshot lives").toBeTruthy();
    // Exactly what the `reset:assets` step of `npm run reset` uploads.
    const storage = new R2AssetStorage(
      (await runtime.getR2Bucket("ASSETS")) as unknown as R2BucketPort,
    );
    await storage.put({
      key: seededAsset?.storageKey as string,
      contentType: "image/png",
      bytes,
    });

    const reviewService = new ReviewService({
      repository: new D1ReviewRepository(database as never),
      proposals: new D1SubmittedProposalAdapter(database as never),
      identities: new D1IdentityDirectory(database as never),
      events,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const content = new ContentService({
      repository: contentRepository,
      assetStorage: storage,
      proposals: reviewService,
      agenda,
      speakerConversion: new D1SpeakerConversion(
        database as never,
        () => crypto.randomUUID(),
        new D1IdentityDirectory(database as never),
      ),
      eventPublication: {
        isEventPublished: async (eventId) =>
          (await publicationRepository.findByEventId(eventId))?.state === "published",
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const app = createHttpApp(
      events,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { demoMode: false },
      reviewService,
      undefined,
      content,
      undefined,
      agenda,
      undefined,
      publishing,
    );

    // The gallery's `photoUrl`, fetched the way a visitor's browser fetches it: no session.
    const anonymous = await app.request(`/api/speaker-assets/${SEEDED_HEADSHOT}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("content-type")).toBe("image/png");
    // Storable, but never usable without asking: unpublishing has to be visible at once.
    expect(anonymous.headers.get("cache-control")).toBe("public, no-cache");
    const served = new Uint8Array(await anonymous.arrayBuffer());
    expect(served.byteLength).toBe(bytes.byteLength);
    expect([...served.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // The public schedule off the real seed, through the real D1 agenda and publication
    // repositories: the placed session under its public slug, and no storage id at all.
    const schedule = await app.request(`/api/public/events/${DEMO_SLUG}/schedule`);
    expect(schedule.status).toBe(200);
    expect(schedule.headers.get("cache-control")).toBe("public, no-cache");
    const scheduleBody = await schedule.text();
    expect(JSON.parse(scheduleBody)).toEqual({
      schedule: {
        eventSlug: DEMO_SLUG,
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
          {
            slug: "accessible-by-default",
            title: "Accessible by default",
            abstract:
              "A hands-on guide to making conference experiences work for more attendees from the first sketch.",
            format: "60-minute workshop",
            track: "Practice",
            speakerSlugs: ["jordan-bell"],
            startsAt: "2026-09-02T17:00:00.000Z",
            endsAt: "2026-09-02T18:00:00.000Z",
            room: "Workshop lab",
          },
        ],
      },
    });
    expect(scheduleBody).not.toMatch(UUID_PATTERN);
    expect(scheduleBody).not.toMatch(/room-main|track-platform|slot-0900|placement-opening/);

    // Unpublishing the event withdraws the bytes it exposed.
    await publishing.unpublish(await resolveSeededDemoActor("organizer"), DEMO_EVENT);
    expect((await app.request(`/api/speaker-assets/${SEEDED_HEADSHOT}`)).status).toBe(404);
    expect((await app.request(`/api/public/events/${DEMO_SLUG}/schedule`)).status).toBe(404);
  });
});
