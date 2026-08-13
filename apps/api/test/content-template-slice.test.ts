// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it } from "vitest";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "../src/adapters/content/sanitize-resource-html";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import {
  speakerChecklistTemplateSlice,
  speakerResourceTemplateSlice,
} from "../src/application/content/public";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const SOURCE_PROFILE = "10000000-0000-4000-8000-000000000001";
const DESTINATION_PROFILE = "10000000-0000-4000-8000-000000000002";
const SOURCE_ASSET = "20000000-0000-4000-8000-000000000001";

const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

/**
 * What `EventTemplateService` hands a slice alongside the payload. Content's resources carry no
 * instant of their own, so the slice ignores it — but a test calling a slice directly still has
 * to supply what its callers supply.
 */
const REMAP = {
  destination: { ...DESTINATION_RANGE, eventId: DESTINATION, timezone: "America/Los_Angeles" },
  source: { eventId: SOURCE, timezone: "America/Los_Angeles" },
};

const CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "content:read",
  "content:manage",
] as const satisfies readonly Capability[];

const organizer: Actor = {
  id: "seed-organizer",
  name: "Olivia Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [SOURCE, DESTINATION].map((eventId) => ({
    eventId,
    role: "organizer" as const,
    capabilities: new Set<Capability>(CAPABILITIES),
  })),
  capabilities: new Set<Capability>(CAPABILITIES),
};

/**
 * The hosts this deployment allows an organizer to embed. The slice is handed these by the
 * composition root and never reads them from the payload, so a stored template cannot
 * authorize its own iframe.
 */
const ALLOWED_EMBED_HOSTS = ["docs.example.com"];

/*
 * The source's resources hold markup no composer would have stored.
 *
 * That is the case worth testing rather than an unrealistic one: a template payload is at rest
 * in a table an operator can write to, so by the time it is applied it is untrusted input
 * whatever it looked like when it was captured. Seeding the repository directly is how a row
 * that never passed the sanitizer gets to exist.
 */
const HOSTILE_BODY =
  '<p onclick="steal()">Bring your own dongle<script>alert(1)</script></p>' +
  '<a href="javascript:alert(2)">rehearsal notes</a>';
const HOSTILE_ALLOWED_EMBED =
  '<iframe src="https://docs.example.com/walkthrough" onload="steal()"></iframe>';
const DISALLOWED_EMBED = '<iframe src="https://evil.example/reel"></iframe>';

function setup() {
  const repository = new MemoryContentRepository({
    sessions: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        eventId: SOURCE,
        proposalId: "proposal-1",
        title: "Scaling the green room",
        abstract: "How we did it",
        format: "talk",
        speakerProfileIds: [SOURCE_PROFILE],
        tags: [],
        tracks: [],
        publicationState: "draft",
      },
    ],
    speakers: [
      {
        id: SOURCE_PROFILE,
        eventId: SOURCE,
        userId: "speaker-user",
        sourcePersonId: "source-1",
        name: "Sam Speaker",
        email: "sam@example.test",
        bio: "Runs the platform team",
        pronouns: "they/them",
        organization: "Example",
      },
    ],
    tasks: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        eventId: SOURCE,
        speakerProfileId: SOURCE_PROFILE,
        title: "Upload a headshot",
        dueAt: "2026-09-01T00:00:00.000Z",
        status: "open",
      },
    ],
    assets: [
      {
        id: SOURCE_ASSET,
        eventId: SOURCE,
        speakerProfileId: SOURCE_PROFILE,
        name: "slides.pdf",
        contentType: "application/pdf",
        storageKey: "source/slides.pdf",
        visibility: "private",
        uploadedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        eventId: SOURCE,
        speakerProfileId: SOURCE_PROFILE,
        subject: "You are accepted",
        sentAt: "2026-08-02T00:00:00.000Z",
      },
    ],
    resources: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        eventId: SOURCE,
        title: "Recording checklist",
        slug: "recording-checklist",
        bodyHtml: HOSTILE_BODY,
        embedHtml: "",
        visibility: "visible",
        sortOrder: 0,
      },
      {
        id: "60000000-0000-4000-8000-000000000002",
        eventId: SOURCE,
        title: "Slide walkthrough",
        slug: "slide-walkthrough",
        bodyHtml: "<p>Watch before you write anything</p>",
        embedHtml: HOSTILE_ALLOWED_EMBED,
        visibility: "visible",
        sortOrder: 1,
      },
      {
        id: "60000000-0000-4000-8000-000000000003",
        eventId: SOURCE,
        title: "Sponsor reel",
        slug: "sponsor-reel",
        bodyHtml: "<p>Play this first</p>",
        embedHtml: DISALLOWED_EMBED,
        visibility: "hidden",
        sortOrder: 2,
      },
    ],
    comments: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        eventId: SOURCE,
        assetId: SOURCE_ASSET,
        authorId: "seed-organizer",
        authorName: "Olivia Organizer",
        body: "Slide 4 needs a caption",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
    ],
  });

  let sequence = 0;
  const newId = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const content = new ContentService({
    repository,
    assetStorage: new DeterministicAssetStorage(),
    proposals: {
      acceptedProposal: async () => {
        throw new Error("unused");
      },
    },
    agenda: {
      publishedSessionSchedules: async () => new Map(),
      unscheduleSession: async () => undefined,
    },
    speakerConversion: { createOrLink: async () => ({ speakerId: SOURCE_PROFILE }) },
    newId,
    now,
    sanitizeResourceHtml,
    sanitizeResourceEmbed,
  });

  const eventRepository = new MemoryEventRepository();
  const events = new EventService({ repository: eventRepository, newId, now });
  const templates = new EventTemplateService({
    repository: new MemoryEventTemplateRepository(),
    events,
    slices: [
      speakerResourceTemplateSlice(content, ALLOWED_EMBED_HOSTS),
      speakerChecklistTemplateSlice(content),
    ],
    newId,
    now,
  });

  const ready = (async () => {
    for (const [id, name] of [
      [SOURCE, "Greenroom Demo Summit"],
      [DESTINATION, "Greenroom Demo Summit 2027"],
    ] as const)
      await eventRepository.create({
        id,
        organizationId: ORGANIZATION,
        name,
        timezone: "America/Los_Angeles",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
    // The source's checklist, written the way an organizer's own composer will write it.
    await content.importTaskTemplates(organizer, {
      eventId: SOURCE,
      templates: [
        {
          title: "Upload a headshot",
          description: "Square, at least 800px.",
          sortOrder: 0,
          dueOffsetDays: -30,
        },
        {
          title: "Send slides",
          description: "PDF, 16:9.",
          sortOrder: 1,
          dueOffsetDays: -7,
        },
      ],
      commit: true,
    });
  })();

  return { content, ready, repository, templates };
}

async function captured() {
  const { content, ready, repository, templates } = setup();
  await ready;
  const { template } = await templates.saveFromEvent(organizer, {
    organizationId: ORGANIZATION,
    name: "Annual summit starter",
    sourceEventId: SOURCE,
  });
  return { content, repository, template, templates };
}

const apply = (templates: EventTemplateService, templateId: string) =>
  templates.apply(organizer, DESTINATION, {
    templateId,
    version: 1,
    destination: DESTINATION_RANGE,
  });

describe("Content template slices: speaker portal resources", () => {
  it("copies the shelf and nobody standing at it", async () => {
    const { content, template, templates } = await captured();

    const result = await apply(templates, template.id);

    expect(result.slices.find(({ key }) => key === "content-resources")?.outcome).toBe("applied");
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.resources?.map(({ slug }) => slug)).toEqual([
      "recording-checklist",
      "slide-walkthrough",
    ]);
    // Everything else content owns stays in the event that owns it. These are real people,
    // their unpublished files and messages already sent to them.
    expect(destination.sessions).toEqual([]);
    expect(destination.speakers).toEqual([]);
    expect(destination.tasks).toEqual([]);
    expect(destination.assets).toEqual([]);
    expect(destination.messages).toEqual([]);
    expect(destination.comments).toEqual([]);
    expect(JSON.stringify(destination)).not.toContain("sam@example.test");
    // And the source is untouched by having been read.
    const source = await content.workspace(organizer, SOURCE);
    expect(source.speakers).toHaveLength(1);
    expect(source.resources).toHaveLength(3);
  });

  it("names every category it deliberately leaves behind, and writes nothing to preview it", async () => {
    const { content, template, templates } = await captured();

    const plan = await templates.preview(organizer, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    const slice = plan.slices.find(({ key }) => key === "content-resources");
    expect(slice?.outcome).toBe("copies");
    expect(slice?.copies.map(({ id }) => id)).toEqual(["recording-checklist", "slide-walkthrough"]);
    expect(slice?.excludes.map(({ id }) => id)).toEqual([
      "sessions",
      "speakers",
      "tasks",
      "assets",
      "messages",
    ]);
    expect(slice?.incompatible.map(({ id }) => id)).toEqual(["sponsor-reel"]);
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.resources).toEqual([]);
  });

  it("sanitizes the stored payload on import, so hostile markup survives nowhere", async () => {
    const { content, template, templates } = await captured();
    // The captured payload really does carry the hostile bytes: this is a test about the
    // import boundary, not about the composer that never ran.
    const stored = JSON.stringify(
      (await templates.get(organizer, template.id)).versions[0]?.payload.slices[
        "content-resources"
      ],
    );
    expect(stored).toContain("<script>");
    expect(stored).toContain("onload=");

    await apply(templates, template.id);

    const destination = await content.workspace(organizer, DESTINATION);
    const written = JSON.stringify(destination.resources);
    expect(written).not.toMatch(/script|onclick|onload|javascript:/i);
    expect(written).not.toContain("evil.example");
    expect(destination.resources?.[0]?.bodyHtml).toBe(
      '<p>Bring your own dongle</p><a rel="noopener noreferrer">rehearsal notes</a>',
    );
    expect(destination.resources?.[1]?.embedHtml).toBe(
      '<iframe src="https://docs.example.com/walkthrough"></iframe>',
    );
  });

  it("reports a resource whose embed this event will not host, and copies the rest", async () => {
    const { content, template, templates } = await captured();

    const result = await apply(templates, template.id);

    const slice = result.slices.find(({ key }) => key === "content-resources");
    expect(slice?.applied.map(({ id }) => id)).toEqual([
      "recording-checklist",
      "slide-walkthrough",
    ]);
    expect(slice?.incompatible[0]?.id).toBe("sponsor-reel");
    expect(slice?.incompatible[0]?.label).toContain("evil.example");
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.resources?.some(({ slug }) => slug === "sponsor-reel")).toBe(false);
  });

  it("previews the outcome applying reports, before and after it has been applied", async () => {
    const { template, templates } = await captured();
    const previewed = async () =>
      (
        await templates.preview(organizer, DESTINATION, {
          templateId: template.id,
          version: 1,
          destination: DESTINATION_RANGE,
        })
      ).slices.find(({ key }) => key === "content-resources");

    const before = await previewed();
    const result = (await apply(templates, template.id)).slices.find(
      ({ key }) => key === "content-resources",
    );
    const after = await previewed();

    expect(before?.outcome).toBe("copies");
    expect(result?.outcome).toBe("applied");
    /*
     * The second preview describes the state the apply beside it produced.
     *
     * It used to answer "incompatible" here — every resource already present, one embed still
     * refused — while apply answered "applied" for that same state, and while its own copies
     * list named two resources. A preview that contradicts the write it predicts is worse than
     * no preview: an organizer reads it as "this template does not fit this event".
     */
    expect(after?.outcome).toBe("copies");
    expect(after?.copies.map(({ id }) => id)).toEqual(result?.applied.map(({ id }) => id));
    expect(after?.incompatible.map(({ id }) => id)).toEqual(
      result?.incompatible.map(({ id }) => id),
    );
    expect(after?.reason).toContain("applying writes nothing");
    // One resource is refused, so the sentence naming it is singular throughout.
    expect(after?.reason).toContain("One resource the destination will not host is left out");
  });

  it("refuses a payload that names one slug twice, rather than never converging on it", async () => {
    const { content } = await captured();
    const slice = speakerResourceTemplateSlice(content, ALLOWED_EMBED_HOSTS);
    const line = {
      title: "Recording checklist",
      slug: "recording-checklist",
      bodyHtml: "<p>Bring your own dongle</p>",
      embedHtml: "",
      visibility: "visible" as const,
      sortOrder: 0,
    };
    const payload = {
      resources: [line, { ...line, title: "Recording checklist (long)", sortOrder: 1 }],
    };

    /*
     * Both halves refuse, because the second entry overwrites the first at `(event_id, slug)`.
     * Nothing reports that: both are "created" on the first run and on every run after it, so
     * the destination never matches the template and "apply twice, then compare" never holds.
     */
    await expect(slice.preview(organizer, DESTINATION, payload, REMAP)).rejects.toThrow(
      /could not be read/,
    );
    await expect(slice.apply(organizer, DESTINATION, payload, REMAP)).rejects.toThrow(
      /could not be read/,
    );
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.resources).toEqual([]);
  });

  it("converges on a second application: no duplicate slug, and nothing written", async () => {
    const { content, template, templates } = await captured();

    await apply(templates, template.id);
    const afterFirst = await content.workspace(organizer, DESTINATION);
    const second = await apply(templates, template.id);
    const afterSecond = await content.workspace(organizer, DESTINATION);

    const slice = second.slices.find(({ key }) => key === "content-resources");
    expect(slice?.outcome).toBe("applied");
    expect(slice?.reason).toContain("nothing needed to be written");
    // Byte-identical, ids included: the slice compares before it writes, and the store resolves
    // `(event_id, slug)` rather than inserting a second row under the same slug.
    expect(JSON.stringify(afterSecond.resources)).toBe(JSON.stringify(afterFirst.resources));
    expect(afterSecond.resources).toHaveLength(2);
  });
});

describe("Content template slices: speaker task checklists", () => {
  it("copies the checklist lines and assigns nobody anything", async () => {
    const { content, template, templates } = await captured();

    const result = await apply(templates, template.id);

    expect(result.slices.find(({ key }) => key === "content-checklists")?.outcome).toBe("applied");
    const copied = await content.taskTemplates(organizer, DESTINATION);
    expect(
      copied.map(({ title, description, sortOrder, dueOffsetDays }) => ({
        title,
        description,
        sortOrder,
        dueOffsetDays,
      })),
    ).toEqual([
      {
        title: "Upload a headshot",
        description: "Square, at least 800px.",
        sortOrder: 0,
        dueOffsetDays: -30,
      },
      { title: "Send slides", description: "PDF, 16:9.", sortOrder: 1, dueOffsetDays: -7 },
    ]);
    // Lines, not work: the destination has no tasks, and the source's assignment stayed there.
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.tasks).toEqual([]);
    const source = await content.workspace(organizer, SOURCE);
    expect(source.tasks).toHaveLength(1);
    // The captured payload carries no assignment either, so nobody's homework is even at rest.
    const payload = JSON.stringify(
      (await templates.get(organizer, template.id)).versions[0]?.payload.slices[
        "content-checklists"
      ],
    );
    expect(payload).not.toContain("Sam Speaker");
    expect(payload).not.toContain("dueAt");
  });

  it("converges on a second application without a second copy of every line", async () => {
    const { content, template, templates } = await captured();

    await apply(templates, template.id);
    const afterFirst = await content.taskTemplates(organizer, DESTINATION);
    const second = await apply(templates, template.id);
    const afterSecond = await content.taskTemplates(organizer, DESTINATION);

    const slice = second.slices.find(({ key }) => key === "content-checklists");
    expect(slice?.reason).toContain("nothing needed to be written");
    expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst));
    expect(afterSecond).toHaveLength(2);
  });

  it("instantiates the copied checklist against named speakers, once per line", async () => {
    const { content, repository, template, templates } = await captured();
    await apply(templates, template.id);
    await repository.addProfile({
      id: DESTINATION_PROFILE,
      eventId: DESTINATION,
      userId: "next-year-speaker",
      sourcePersonId: "source-2",
      name: "Robin Returning",
      email: "robin@example.test",
      bio: "",
      pronouns: "",
      organization: "",
    });

    const assigned = await content.assignTaskChecklist(organizer, {
      eventId: DESTINATION,
      profileIds: [DESTINATION_PROFILE],
      anchorAt: "2027-05-10T00:00:00.000Z",
    });
    const again = await content.assignTaskChecklist(organizer, {
      eventId: DESTINATION,
      profileIds: [DESTINATION_PROFILE],
      anchorAt: "2027-05-10T00:00:00.000Z",
    });

    expect(
      assigned.map(({ title, dueAt, instructions }) => ({ title, dueAt, instructions })),
    ).toEqual([
      {
        title: "Upload a headshot",
        dueAt: "2027-04-10T00:00:00.000Z",
        instructions: "Square, at least 800px.",
      },
      { title: "Send slides", dueAt: "2027-05-03T00:00:00.000Z", instructions: "PDF, 16:9." },
    ]);
    // Idempotent per (profile, line): running it again brings a newcomer up to date and leaves
    // everybody else's work exactly where it was.
    expect(again).toEqual([]);
    const destination = await content.workspace(organizer, DESTINATION);
    expect(destination.tasks).toHaveLength(2);
  });
});
