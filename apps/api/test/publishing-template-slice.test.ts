// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import type { PublicSchedule } from "../src/application/agenda/public";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import {
  PublicationService,
  PublicationSlugTakenError,
  type PublicationSources,
} from "../src/application/publishing/publication-service";
import { publishingTemplateSlice } from "../src/application/publishing/public";
import {
  publicEventSlug,
  type Publication,
  type PublicEventProjection,
} from "../src/domain/publishing/publication";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const NEIGHBOUR = "00000000-0000-4000-8000-000000000003";

const DESTINATION_NAME = "Greenroom Demo Summit 2027";
const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };
const SUMMARY = "Two days of practical conference craft.";
const VENUE = "Harbor Conference Center, Oakland";
const CHOSEN_ADDRESS = "pycon-oakland-2027";
const SOURCE_SESSION = "Designing the calm conference";
const SOURCE_SPEAKER = "Sam Speaker";

const ORGANIZER_CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
] as const satisfies readonly Capability[];

function organizer(eventIds: readonly string[]): Actor {
  return {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [{ id: ORGANIZATION }],
    eventAccess: eventIds.map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
    })),
    capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
  };
}

/**
 * The publishing table, holding the reservation rules migration 1802 actually enforces.
 *
 * A double that let two events hold one address would make every assertion below pass while the
 * real statement refused the write, so the unique `slug`, the unique index over the draft's
 * address, and the pair of triggers spanning both are all modelled here — as
 * `PublicationSlugTakenError`, which is what `D1PublicationRepository` raises for each of them.
 * `writes` counts draft writes, because "applying twice writes nothing" is a claim about how
 * often this table is touched and not only about what it ends up holding.
 */
class FixtureProjections implements PublicationRepository {
  readonly rows = new Map<string, Publication>();
  writes = 0;

  async findPublicBySlug(slug: string): Promise<Publication | null> {
    return (
      [...this.rows.values()].find((row) => row.slug === slug && row.state === "published") ?? null
    );
  }

  async findByEventId(eventId: string): Promise<Publication | null> {
    return this.rows.get(eventId) ?? null;
  }

  async findEventIdBySlug(slug: string): Promise<string | null> {
    return (
      [...this.rows.values()].find((row) => row.slug === slug || row.draft.event.slug === slug)
        ?.eventId ?? null
    );
  }

  async saveSettings(
    eventId: string,
    slug: string,
    draft: PublicEventProjection,
  ): Promise<Publication | null> {
    this.writes += 1;
    this.refuseTakenAddress(eventId, [slug, draft.event.slug]);
    const existing = this.rows.get(eventId);
    // The row's `slug` column is the address being served, so a draft edit may only move it
    // while nothing is published — exactly the CASE in the D1 upsert.
    const row: Publication = existing
      ? { ...existing, draft, ...(existing.state === "published" ? {} : { slug }) }
      : { eventId, slug, state: "draft", draft, published: null, publishedAt: null };
    this.rows.set(eventId, row);
    return row;
  }

  async publish(
    eventId: string,
    publishedAt: string,
    projection: PublicEventProjection,
  ): Promise<Publication | null> {
    this.refuseTakenAddress(eventId, [projection.event.slug]);
    const row: Publication = {
      eventId,
      slug: projection.event.slug,
      state: "published",
      draft: projection,
      published: projection,
      publishedAt,
    };
    this.rows.set(eventId, row);
    return row;
  }

  async unpublish(eventId: string): Promise<Publication | null> {
    const existing = this.rows.get(eventId);
    if (!existing) return null;
    const row: Publication = {
      ...existing,
      state: "unpublished",
      published: null,
      publishedAt: null,
    };
    this.rows.set(eventId, row);
    return row;
  }

  private refuseTakenAddress(eventId: string, addresses: readonly string[]) {
    const taken = [...this.rows.values()].some(
      (row) =>
        row.eventId !== eventId &&
        (addresses.includes(row.slug) || addresses.includes(row.draft.event.slug)),
    );
    if (taken) throw new PublicationSlugTakenError("That public address is already taken.");
  }
}

/** A published agenda whose slots open and close on the given days. */
const scheduleOver = (eventId: string, days: readonly string[]): PublicSchedule => ({
  eventId,
  version: 1,
  publishedAt: "2026-08-11T00:00:00.000Z",
  agenda: {
    eventId,
    rooms: [],
    tracks: [],
    slots: days.map((day, index) => ({
      id: `slot-${index}`,
      startsAt: `${day}T16:00:00.000Z`,
      endsAt: `${day}T17:00:00.000Z`,
    })),
    sessions: [],
    placements: [],
  },
});

async function setup(
  options: { blankSource?: boolean; destinationAgendaDays?: readonly string[] } = {},
) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const eventRepository = new MemoryEventRepository();
  for (const [id, name] of [
    [SOURCE, "Greenroom Demo Summit"],
    [DESTINATION, DESTINATION_NAME],
    [NEIGHBOUR, "Harbor Summit"],
  ] as const)
    await eventRepository.create({
      id,
      organizationId: ORGANIZATION,
      name,
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  const events = new EventService({ repository: eventRepository, newId, now });

  /*
   * The real composer, wired to the real service: the source's page is built from the same
   * projection code the product runs, so the sessions and speakers this slice must not carry
   * are genuinely on it rather than merely absent from a stub.
   */
  const sources: PublicationSources = {
    event: async (actor, eventId) => {
      const event = await events.get(actor, eventId);
      return event ? { name: event.name, timezone: event.timezone } : null;
    },
    cfp: async () => null,
    content: {
      publishedEventContent: async (eventId) =>
        eventId === SOURCE
          ? {
              sessions: [
                {
                  id: "20000000-0000-4000-8000-000000000001",
                  title: SOURCE_SESSION,
                  abstract: "A practical guide to reducing operational noise.",
                  format: "45-minute talk",
                  speakerProfileIds: ["10000000-0000-4000-8000-000000000001"],
                  tags: [],
                  tracks: ["Platform"],
                },
              ],
              speakers: [
                {
                  id: "10000000-0000-4000-8000-000000000001",
                  name: SOURCE_SPEAKER,
                  bio: "Builds humane conference tools.",
                  pronouns: "they/them",
                  organization: "Greenroom Labs",
                },
              ],
              assets: [],
            }
          : { sessions: [], speakers: [], assets: [] },
    },
    schedule: async (eventId) =>
      options.destinationAgendaDays && eventId === DESTINATION
        ? scheduleOver(eventId, options.destinationAgendaDays)
        : null,
  };

  const projections = new FixtureProjections();
  const publishing = new PublicationService(projections, sources, now);
  const actor = organizer([SOURCE, DESTINATION, NEIGHBOUR]);
  if (!options.blankSource) {
    // The state a template is captured from in the product: an organizer typed the two public
    // fields they own, and the page is live.
    await publishing.updateSettings(actor, SOURCE, { summary: SUMMARY, venue: VENUE });
    await publishing.publish(actor, SOURCE);
  }
  // Nothing below asserts about the seed, and every write count is about the destination.
  projections.writes = 0;

  const templates = new EventTemplateService({
    repository: new MemoryEventTemplateRepository(),
    events,
    slices: [
      publishingTemplateSlice(
        publishing,
        projections,
        async (candidate, eventId) => (await events.get(candidate, eventId))?.name ?? null,
      ),
    ],
    newId,
    now,
  });
  return { actor, events, projections, publishing, templates };
}

const save = (templates: EventTemplateService, actor: Actor) =>
  templates.saveFromEvent(actor, {
    organizationId: ORGANIZATION,
    name: "Annual summit starter",
    sourceEventId: SOURCE,
  });

const apply = (templates: EventTemplateService, actor: Actor, templateId: string) =>
  templates.apply(actor, DESTINATION, {
    templateId,
    version: 1,
    destination: DESTINATION_RANGE,
  });

const publishingSlice = <T extends { key: string }>(reports: readonly T[]) =>
  reports.find(({ key }) => key === "publishing");

describe("Event templates: the public page", () => {
  it("captures the two fields an organizer types and nothing that identifies the source", async () => {
    const { actor, templates } = await setup();

    const capture = await save(templates, actor);

    expect(capture.slices).toEqual([
      {
        key: "publishing",
        label: "Public page details",
        outcome: "captured",
        reason: expect.any(String),
      },
    ]);
    expect(capture.version.payload.slices.publishing).toEqual({ summary: SUMMARY, venue: VENUE });
    // The source's address, its live snapshot and its programme are all absent from the stored
    // version — a template that carried any of them could only ever be refused or be wrong.
    const stored = JSON.stringify(capture.version.payload);
    expect(stored).not.toMatch(/greenroom-demo-summit-/);
    expect(stored).not.toMatch(/publishedAt|sessions|speakers/);
    expect(stored).not.toContain(SOURCE_SESSION);
    expect(stored).not.toContain(SOURCE_SPEAKER);
  });

  it("captures nothing from an event whose organizer has typed no public details", async () => {
    const { actor, templates } = await setup({ blankSource: true });

    const capture = await save(templates, actor);

    expect(publishingSlice(capture.slices)?.outcome).toBe("empty");
    expect(capture.version.payload.slices.publishing).toBeUndefined();
  });

  it("copies the summary and venue, and stores the dates the organizer confirmed", async () => {
    const { actor, projections, templates } = await setup();
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(result.outcome).toBe("applied");
    expect(publishingSlice(result.slices)?.outcome).toBe("applied");
    // The confirmed range becomes stored state here and nowhere else: events carry no dates of
    // their own, so an unwritten range would leave the public page with no days at all.
    expect(projections.rows.get(DESTINATION)?.draft.event).toMatchObject({
      name: DESTINATION_NAME,
      summary: SUMMARY,
      venue: VENUE,
      startsOn: "2027-05-10",
      endsOn: "2027-05-12",
    });
  });

  it("derives a first address from the destination's own name rather than copying the source's", async () => {
    const { actor, projections, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);

    const destination = projections.rows.get(DESTINATION);
    const source = projections.rows.get(SOURCE);
    expect(destination?.draft.event.slug).toMatch(/^greenroom-demo-summit-2027-[a-z0-9]+$/);
    expect(destination?.draft.event.slug).not.toBe(source?.draft.event.slug);
    // The call for proposals is advertised at the address the destination actually answers on.
    expect(destination?.draft.cfp.submissionUrl).toBe(
      `/events/${destination?.draft.event.slug}/cfp`,
    );
    // And the source keeps serving the address people were already given.
    expect(source).toMatchObject({ state: "published", slug: source?.draft.event.slug });
  });

  it("keeps the public address the destination's organizer chose and published", async () => {
    const { actor, projections, publishing, templates } = await setup();
    // The address an organizer typed and handed out. This template carries none at all, so
    // there is nothing in it with any standing to move the URL people were already given.
    await publishing.updateSettings(actor, DESTINATION, { slug: CHOSEN_ADDRESS });
    await publishing.publish(actor, DESTINATION);
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(publishingSlice(result.slices)?.outcome).toBe("applied");
    const destination = projections.rows.get(DESTINATION);
    // The draft's address is what the next publish will serve, so it is the one that decides
    // whether the live URL moves — and it, the served column, and the CFP link all stay put.
    expect(destination?.draft.event.slug).toBe(CHOSEN_ADDRESS);
    expect(destination?.slug).toBe(CHOSEN_ADDRESS);
    expect(destination?.draft.cfp.submissionUrl).toBe(`/events/${CHOSEN_ADDRESS}/cfp`);
    expect(destination?.published?.event.slug).toBe(CHOSEN_ADDRESS);
    // The template's own material did arrive, so this is a preserved address and not a no-op.
    expect(destination?.draft.event).toMatchObject({ summary: SUMMARY, venue: VENUE });
    // The source's address remains the source's, whichever address the destination holds.
    expect(destination?.draft.event.slug).not.toBe(projections.rows.get(SOURCE)?.draft.event.slug);
  });

  it("carries no published snapshot, no sessions and no speakers onto the destination", async () => {
    const { actor, projections, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);

    const destination = projections.rows.get(DESTINATION);
    expect(destination).toMatchObject({ state: "draft", published: null, publishedAt: null });
    expect(destination?.draft.sessions).toEqual([]);
    expect(destination?.draft.speakers).toEqual([]);
    // The source's page is live and holds both; neither may reach an event that has accepted
    // nothing and asked nobody to speak.
    expect(JSON.stringify(projections.rows.get(SOURCE))).toContain(SOURCE_SESSION);
    expect(JSON.stringify(destination)).not.toContain(SOURCE_SESSION);
    expect(JSON.stringify(destination)).not.toContain(SOURCE_SPEAKER);
  });

  it("lists what it would write and what it leaves behind, writing nothing", async () => {
    const { actor, projections, templates } = await setup();
    const { template } = await save(templates, actor);

    const plan = await templates.preview(actor, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    const slice = publishingSlice(plan.slices);
    expect(slice?.outcome).toBe("copies");
    expect(slice?.copies.map(({ id }) => id)).toEqual(["summary", "venue", "address", "dates"]);
    expect(slice?.copies.find(({ id }) => id === "dates")?.label).toContain(
      "2027-05-10 to 2027-05-12",
    );
    // The published snapshot's omission is visible rather than merely true.
    expect(slice?.excludes.map(({ id }) => id)).toEqual(["published", "sessions", "speakers"]);
    expect(projections.rows.has(DESTINATION)).toBe(false);
    expect(projections.writes).toBe(0);
  });

  it("reports an address another event already holds as incompatible, not as a failure", async () => {
    const { actor, projections, publishing, templates } = await setup();
    // A neighbouring event has reserved, in its own draft, exactly the address the destination's
    // name derives to. Deriving is unique-ish; the index and the triggers are what is
    // authoritative, and this is what they would refuse.
    await publishing.updateSettings(actor, NEIGHBOUR, {
      slug: publicEventSlug(DESTINATION_NAME, DESTINATION),
    });
    const { template } = await save(templates, actor);
    projections.writes = 0;

    const result = await apply(templates, actor, template.id);

    const slice = publishingSlice(result.slices);
    expect(slice?.outcome).toBe("incompatible");
    expect(slice?.reason).toMatch(/already belongs to another event/);
    expect(slice?.reason).toMatch(/Choose a different public address for this event/);
    expect(slice?.incompatible.map(({ id }) => id)).toEqual(["address"]);
    // Nothing half-applied, and nothing raised: the organizer is told which address to choose
    // and the clone as a whole is still a reported result rather than a 500.
    expect(result.outcome).toBe("applied");
    expect(projections.rows.has(DESTINATION)).toBe(false);
    expect(projections.writes).toBe(0);
  });

  it("applies on the retry the refusal asks for, once the organizer has chosen an address", async () => {
    const { actor, projections, publishing, templates } = await setup();
    await publishing.updateSettings(actor, NEIGHBOUR, {
      slug: publicEventSlug(DESTINATION_NAME, DESTINATION),
    });
    const { template } = await save(templates, actor);
    expect(publishingSlice((await apply(templates, actor, template.id)).slices)?.outcome).toBe(
      "incompatible",
    );

    // The remedy the refusal names, performed exactly as it is written. A clone that derived
    // the address again would refuse this a second time, leaving the template unappliable to
    // this destination for as long as it keeps its name.
    await publishing.updateSettings(actor, DESTINATION, { slug: CHOSEN_ADDRESS });
    const retried = await apply(templates, actor, template.id);

    expect(publishingSlice(retried.slices)?.outcome).toBe("applied");
    expect(projections.rows.get(DESTINATION)?.draft.event).toMatchObject({
      slug: CHOSEN_ADDRESS,
      summary: SUMMARY,
      venue: VENUE,
    });
    // And the neighbour still holds the address it reserved.
    expect(projections.rows.get(NEIGHBOUR)?.draft.event.slug).toBe(
      publicEventSlug(DESTINATION_NAME, DESTINATION),
    );
  });

  it("reports an address taken between the check and the write the same way", async () => {
    const { actor, projections, publishing, templates } = await setup();
    await publishing.updateSettings(actor, NEIGHBOUR, {
      slug: publicEventSlug(DESTINATION_NAME, DESTINATION),
    });
    const { template } = await save(templates, actor);
    // The race issue #124 made a 409: the reservation read answers "free", and the address is
    // taken by the time the write reaches the table.
    vi.spyOn(projections, "findEventIdBySlug").mockResolvedValueOnce(null);

    const result = await apply(templates, actor, template.id);

    expect(publishingSlice(result.slices)).toMatchObject({
      outcome: "incompatible",
      reason: expect.stringContaining("already belongs to another event"),
    });
    expect(projections.rows.has(DESTINATION)).toBe(false);
  });

  it("converges: a second application writes nothing at all", async () => {
    const { actor, projections, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);
    const afterFirst = JSON.stringify(projections.rows.get(DESTINATION));
    const written = projections.writes;
    const second = await apply(templates, actor, template.id);

    expect(publishingSlice(second.slices)).toMatchObject({
      outcome: "applied",
      reason: expect.stringContaining("nothing needed to be written"),
    });
    // Not merely byte-identical afterwards: the row is never touched a second time, so the
    // reservation triggers never run again over a change nobody made.
    expect(projections.writes).toBe(written);
    expect(JSON.stringify(projections.rows.get(DESTINATION))).toBe(afterFirst);
  });

  it("stores the confirmed dates even when the destination's agenda already composes them", async () => {
    /*
     * The trap in comparing against the composed page instead of the stored row. Agenda's own
     * slice remaps its slots into the confirmed range, so `preview` fills empty stored dates
     * with exactly the days this template would write — and a slice comparing against that
     * would call the destination converged and leave `draft_json` holding no dates at all,
     * pinning the public page to whatever the agenda says next.
     */
    const { actor, projections, publishing, templates } = await setup({
      destinationAgendaDays: ["2027-05-10", "2027-05-12"],
    });
    const { template } = await save(templates, actor);
    await apply(templates, actor, template.id);
    await publishing.updateSettings(actor, DESTINATION, { startsOn: "", endsOn: "" });
    expect(projections.rows.get(DESTINATION)?.draft.event).toMatchObject({
      startsOn: "",
      endsOn: "",
    });

    await apply(templates, actor, template.id);

    expect(projections.rows.get(DESTINATION)?.draft.event).toMatchObject({
      startsOn: "2027-05-10",
      endsOn: "2027-05-12",
    });
  });
});
