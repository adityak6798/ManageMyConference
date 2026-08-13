// @acceptance ACC-EVENT-TEMPLATES
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "../src/adapters/content/sanitize-resource-html";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import { D1CfpRepository } from "../src/adapters/persistence/d1-cfp-repository";
import { D1ContentRepository } from "../src/adapters/persistence/d1-content-repository";
import type { D1DatabasePort } from "../src/adapters/persistence/d1-event-repository";
import { D1EventRepository } from "../src/adapters/persistence/d1-event-repository";
import { D1EventTemplateRepository } from "../src/adapters/persistence/d1-event-template-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import { D1PublicationRepository } from "../src/adapters/persistence/d1-publication-repository";
import { D1ReviewRepository } from "../src/adapters/persistence/d1-review-repository";
import { D1SubmittedProposalAdapter } from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { agendaTemplateSlice } from "../src/application/agenda/public";
import { CfpService } from "../src/application/cfp/cfp-service";
import { CfpUnavailableError, cfpTemplateSlice } from "../src/application/cfp/public";
import { ContentService } from "../src/application/content/content-service";
import {
  speakerChecklistTemplateSlice,
  speakerResourceTemplateSlice,
} from "../src/application/content/public";
import { EventService } from "../src/application/events/event-service";
import {
  EventTemplateNameTakenError,
  EventTemplateService,
} from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { PublicationService, publishingTemplateSlice } from "../src/application/publishing/public";
import { reviewTemplateSlice } from "../src/application/review/public";
import { ReviewService } from "../src/application/review/review-service";
import { createMigratedDatabase } from "./support/seeded-d1";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };
/** The address the seed published the source event under, which the clone must not reuse. */
const SOURCE_SLUG = "greenroom-demo-summit";

/** Every slice the composition root binds, so "all six ran" is a statement rather than a hope. */
const SLICE_KEYS = [
  "review",
  "cfp",
  "agenda",
  "publishing",
  "content-resources",
  "content-checklists",
] as const;

/**
 * What `D1IdentityDirectory` grants an organizer of an event, plus the organization-level
 * `events:create`.
 *
 * Taken whole rather than narrowed to the capabilities the slices happen to need today: a slice
 * that loses a capability reports `unauthorized` and writes nothing, which this sweep would then
 * read as a clean clone. The actor a real request carries is the only one that cannot lie here.
 */
const CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
] as const satisfies readonly Capability[];

/**
 * The actor a request would carry, rebuilt after each grant.
 *
 * Building it per call rather than once is the point of `ARC-FLOW-006`'s two-step design in
 * miniature: the organizer role `EventService.create` grants lands in D1 and does not reach the
 * actor the creating request already resolved, so configuring the new event needs a session that
 * was read after the grant.
 */
function actorFor(eventIds: readonly string[]): Actor {
  return {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [{ id: ORGANIZATION }],
    eventAccess: eventIds.map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: new Set<Capability>(CAPABILITIES),
    })),
    capabilities: new Set<Capability>(CAPABILITIES),
  };
}

const OWNERSHIP = JSON.parse(
  await readFile(new URL("../../../table-ownership.json", import.meta.url), "utf8"),
) as { tables: Record<string, string> };

let sequence = 0;

/**
 * A collaborator the clone has no route to, wired so that being wrong about it fails loudly.
 *
 * Each one belongs to a command no slice calls — sending mail, moving bytes in and out of R2,
 * announcing a schedule publication. A silent double would let a slice that started reaching one
 * of them pass this test while doing something a clone must never do; throwing turns that same
 * change into a named failure. Nothing the clone actually goes through is stubbed.
 */
const unreachable = (what: string) => () => {
  throw new Error(`${what} is not reachable while applying a template`);
};

function compose(database: D1DatabasePort) {
  // Offset past the seed's own id space, so a generated event never lands on a seeded one.
  const newId = () => `00000000-0000-4000-8000-${String(1000 + ++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");
  const identity = new D1IdentityDirectory(
    database as ConstructorParameters<typeof D1IdentityDirectory>[0],
  );
  const events = new EventService({
    repository: new D1EventRepository(database),
    newId,
    now,
    grantOrganizer: (eventId, userId) => identity.grantOrganizer(eventId, userId),
  });
  const proposals = new D1SubmittedProposalAdapter(
    database as ConstructorParameters<typeof D1SubmittedProposalAdapter>[0],
  );
  const contentRepository = new D1ContentRepository(
    database as ConstructorParameters<typeof D1ContentRepository>[0],
  );
  const publications = new D1PublicationRepository(
    database as ConstructorParameters<typeof D1PublicationRepository>[0],
  );
  const cfp = new CfpService(
    new D1CfpRepository(database as ConstructorParameters<typeof D1CfpRepository>[0]),
    newId,
    now,
    proposals,
  );
  const review = new ReviewService({
    repository: new D1ReviewRepository(
      database as ConstructorParameters<typeof D1ReviewRepository>[0],
    ),
    proposals,
    identities: identity,
    events,
    notifications: {
      reviewerAssigned: unreachable("Reviewer notification"),
      decisionRecorded: unreachable("Decision notification"),
    },
    newId,
    now,
  });
  const agenda = new AgendaService(
    new D1AgendaRepository(
      database as ConstructorParameters<typeof D1AgendaRepository>[0],
      now,
      unreachable("The schedule-publication outbox writer"),
    ),
    now,
    contentRepository,
    async (actor, eventId) => {
      const event = await events.get(actor, eventId);
      return Boolean(event && actor.organizations.some(({ id }) => id === event.organizationId));
    },
  );
  const content = new ContentService({
    repository: contentRepository,
    identities: identity,
    speakerNotifications: {
      speakerAccepted: unreachable("Speaker acceptance notification"),
      taskAssigned: unreachable("Task assignment notification"),
    },
    assetStorage: {
      put: unreachable("Asset storage"),
      get: unreachable("Asset storage"),
      delete: unreachable("Asset storage"),
    },
    proposals: review,
    agenda,
    speakerConversion: new D1SpeakerConversion(database, newId, identity),
    eventPublication: {
      isEventPublished: async (eventId) =>
        (await publications.findByEventId(eventId))?.state === "published",
    },
    newId,
    now,
    // Real, because the resource clone genuinely goes through both: a cloned body is
    // re-sanitized on the way in, and a cloned embed is re-authorized against the destination's
    // allowlist rather than the payload's.
    sanitizeResourceHtml,
    sanitizeResourceEmbed,
  });
  const publishing = new PublicationService(publications, {
    event: async (actor, eventId) => {
      const event = await events.get(actor, eventId);
      return event ? { name: event.name, timezone: event.timezone } : null;
    },
    cfp: async (eventId) => {
      try {
        const form = await cfp.getPublished(eventId);
        return {
          title: form.title,
          description: form.description,
          status: form.status === "closed" ? ("closed" as const) : ("open" as const),
          publishedAt: form.publishedAt,
        };
      } catch (error) {
        // ERROR-INTENT: an event with no published form has no CFP on its public page, which is
        // the destination's state throughout this test. The composition root answers it the same
        // way, and reading it as a fault here would hide the very thing the sweep asserts.
        if (error instanceof CfpUnavailableError) return null;
        throw error;
      }
    },
    content: contentRepository,
    schedule: (eventId) => agenda.published(eventId),
  });
  const repository = new D1EventTemplateRepository(database);
  return {
    agenda,
    cfp,
    content,
    events,
    identity,
    publishing,
    repository,
    review,
    templates: new EventTemplateService({
      repository,
      events,
      // Every slice the Worker binds, in the Worker's order — review before CFP, because a
      // routing rule is only copyable into a destination that already configures the status it
      // names. The empty embed allowlist is the composition root's own argument.
      slices: [
        reviewTemplateSlice(review),
        cfpTemplateSlice(cfp),
        agendaTemplateSlice(agenda),
        publishingTemplateSlice(
          publishing,
          publications,
          async (actor, eventId) => (await events.get(actor, eventId))?.name ?? null,
        ),
        speakerResourceTemplateSlice(content, []),
        speakerChecklistTemplateSlice(content),
      ],
      newId,
      now,
    }),
  };
}

/** Every table the ownership manifest declares that this database actually has. */
async function presentTables(database: D1DatabasePort): Promise<string[]> {
  const result = await database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const existing = new Set((result.results ?? []).map(({ name }) => name));
  return Object.keys(OWNERSHIP.tables).filter((table) => existing.has(table));
}

async function rowCounts(database: D1DatabasePort, tables: readonly string[]) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await database.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).all<{
      total: number;
    }>();
    counts[table] = result.results?.[0]?.total ?? 0;
  }
  return counts;
}

/** Which of those tables carry an `event_id`, so "nothing landed for this event" is askable. */
async function eventScopedTables(database: D1DatabasePort, tables: readonly string[]) {
  const scoped: string[] = [];
  for (const table of tables) {
    const info = await database.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    if ((info.results ?? []).some(({ name }) => name === "event_id")) scoped.push(table);
  }
  return scoped;
}

async function countForEvent(database: D1DatabasePort, table: string, eventId: string) {
  const counted = await database
    .prepare(`SELECT COUNT(*) AS total FROM "${table}" WHERE event_id = ?`)
    .bind(eventId)
    .all<{ total: number }>();
  return counted.results?.[0]?.total ?? 0;
}

describe("D1EventTemplateRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  /**
   * A seeded database plus an empty destination event, created through the same
   * `EventService.create` + `grantOrganizer` path the Worker composes — so "nothing arrived
   * here" is a statement about the clone rather than about a hand-written fixture row.
   */
  async function seeded() {
    const migrated = await createMigratedDatabase({
      label: "greenroom-event-templates",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as D1DatabasePort;
    const composed = compose(database);
    const destination = await composed.events.create(actorFor([SOURCE]), {
      organizationId: ORGANIZATION,
      name: "Greenroom Demo Summit 2027",
      timezone: "America/New_York",
    });
    return {
      database,
      destinationId: destination.id,
      actor: actorFor([SOURCE, destination.id]),
      ...composed,
    };
  }

  it("round-trips a template, its versions and its applications through real D1", async () => {
    const { actor, database, destinationId, repository, templates } = await seeded();

    const { template } = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Regional summit starter",
      sourceEventId: SOURCE,
    });
    await templates.captureVersion(actor, template.id, SOURCE);
    await templates.apply(actor, destinationId, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    await expect(repository.findTemplate(template.id)).resolves.toMatchObject({
      organizationId: ORGANIZATION,
      name: "Regional summit starter",
      state: "active",
    });
    await expect(repository.nextVersion(template.id)).resolves.toBe(3);
    const versions = await repository.listVersions(template.id);
    expect(versions.map(({ version }) => version)).toEqual([2, 1]);
    expect(versions[0]?.payload.source.eventName).toBe("Greenroom Demo Summit");
    await expect(repository.listApplications(destinationId)).resolves.toEqual([
      {
        templateId: template.id,
        templateName: "Regional summit starter",
        templateVersionId: versions[1]?.id,
        version: 1,
        appliedAt: "2026-08-12T10:00:00.000Z",
      },
    ]);
    // The stored payload survives the `json_valid` CHECK and is queryable as the slice's shape.
    const stored = await database
      .prepare(
        "SELECT json_extract(payload_json, '$.slices.cfp.title') AS title FROM event_template_versions WHERE template_id = ? AND version = 1",
      )
      .bind(template.id)
      .all<{ title: string }>();
    expect(stored.results?.[0]?.title).toBe("Share your conference story");
  });

  it("lets the database, not a read-then-write race, decide that a name is taken", async () => {
    const { actor, repository, templates } = await seeded();
    const save = (name: string) =>
      templates.saveFromEvent(actor, {
        organizationId: ORGANIZATION,
        name,
        sourceEventId: SOURCE,
      });
    const { template } = await save("Regional summit starter");

    await expect(save("Regional summit starter")).rejects.toBeInstanceOf(
      EventTemplateNameTakenError,
    );

    // The unique index is partial over active rows, so archiving genuinely releases the name.
    await repository.updateTemplate(template.id, { state: "archived" }, "2026-08-12T11:00:00.000Z");
    await expect(save("Regional summit starter")).resolves.toMatchObject({
      template: { state: "active" },
    });
  });

  it("records one application row per (event, version) however often it is applied", async () => {
    const { actor, database, destinationId, templates } = await seeded();
    const { template } = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Regional summit starter",
      sourceEventId: SOURCE,
    });
    const command = { templateId: template.id, version: 1, destination: DESTINATION_RANGE };

    await templates.apply(actor, destinationId, command);
    await templates.apply(actor, destinationId, command);

    await expect(
      countForEvent(database, "event_template_applications", destinationId),
    ).resolves.toBe(1);
  });

  it("copies configuration and nothing else out of a fully populated seeded event", async () => {
    const { actor, cfp, database, destinationId, publishing, templates } = await seeded();
    const tables = await presentTables(database);
    /*
     * The sweep is only meaningful if the source is genuinely populated, so prove it is — on
     * both sides of the line. The first three are the categories a clone must never carry; the
     * rest are the ones it must, and a source missing one of those would let an inert slice
     * masquerade as a well-behaved one.
     */
    const before = await rowCounts(database, tables);
    expect(before.cfp_submissions).toBeGreaterThan(0);
    expect(before.speaker_profiles).toBeGreaterThan(0);
    expect(before.review_assignments).toBeGreaterThan(0);
    expect(before.cfp_forms).toBeGreaterThan(0);
    expect(before.cfp_statuses).toBeGreaterThan(0);
    expect(before.review_plans).toBeGreaterThan(0);
    expect(before.agenda_drafts).toBeGreaterThan(0);
    expect(before.public_event_projections).toBeGreaterThan(0);
    expect(before.speaker_resources).toBeGreaterThan(0);
    expect(before.speaker_task_templates).toBeGreaterThan(0);

    const { slices, template, version } = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Regional summit starter",
      sourceEventId: SOURCE,
    });
    /*
     * A capture that quietly came up short would make everything below true and meaningless: an
     * absent slice key is a category the apply skips, and a skipped category writes nothing.
     * So the payload is required to carry all six before its writes are judged.
     */
    expect(Object.keys(version.payload.slices).sort()).toEqual([...SLICE_KEYS].sort());
    expect(slices.map(({ key, outcome }) => [key, outcome])).toEqual(
      SLICE_KEYS.map((key) => [key, "captured"]),
    );

    const result = await templates.apply(actor, destinationId, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });
    // And likewise on the way in: a slice that threw or was refused reports itself rather than
    // failing the request, so an unasserted outcome is a clone that never happened.
    expect(result.outcome).toBe("applied");
    expect(
      result.slices
        .filter(({ key }) => (SLICE_KEYS as readonly string[]).includes(key))
        .map(({ key, outcome }) => [key, outcome]),
    ).toEqual(SLICE_KEYS.map((key) => [key, "applied"]));
    const after = await rowCounts(database, tables);

    /*
     * Driven from `table-ownership.json` rather than from a hand-written list, so a table added
     * later cannot quietly escape the check: any new table an apply writes to shows up here as
     * an unexpected name until somebody decides it belongs.
     */
    const changed = tables.filter((table) => after[table] !== before[table]);
    expect(changed.sort()).toEqual(
      [
        "agenda_drafts",
        "cfp_forms",
        "cfp_statuses",
        "event_template_applications",
        "event_template_versions",
        "event_templates",
        "public_event_projections",
        "review_plans",
        "speaker_resources",
        "speaker_task_templates",
      ].sort(),
    );

    /*
     * And per event: of every table that can name an event, only the ones the six categories
     * account for hold rows for the destination, plus the single organizer grant its creation
     * made. No submission, evaluation, assignment, decision, person, task, private file,
     * comment, delivery, itinerary or audit row followed the configuration across.
     *
     * The counts are the categories restated as arithmetic — six triage statuses, one rubric,
     * one form, one board, one public page, one portal resource, three checklist lines — so a
     * category that arrived twice, or brought a row nobody counted, fails on the number rather
     * than on a name somebody remembered to list.
     */
    const expectedForDestination: Record<string, number> = {
      agenda_drafts: 1,
      cfp_forms: 1,
      cfp_statuses: 6,
      event_roles: 1,
      event_template_applications: 1,
      public_event_projections: 1,
      review_plans: 1,
      speaker_resources: 1,
      speaker_task_templates: 3,
    };
    for (const table of await eventScopedTables(database, tables)) {
      const total = await countForEvent(database, table, destinationId);
      expect({ table, total }).toEqual({ table, total: expectedForDestination[table] ?? 0 });
    }

    // The destination's CFP is a draft: no publication came across with the configuration, and
    // the assertion goes through CFP's own surface rather than reading that domain's table.
    await expect(cfp.getForOrganizer(actor, destinationId)).resolves.toMatchObject({
      title: "Share your conference story",
      status: "draft",
      publishedAt: null,
      publishedStatus: null,
    });
    await expect(cfp.getPublished(destinationId)).rejects.toBeInstanceOf(CfpUnavailableError);
    // The source's CFP is published, so that is a real difference rather than an absent feature.
    await expect(cfp.getPublished(SOURCE)).resolves.toMatchObject({ status: "open" });

    /*
     * The same question of the public page, which is where a copied snapshot would be a
     * disclosure rather than a nuisance: the destination has a draft nobody has published, and
     * its address is its own. Publishing derives an address from the destination's own name and
     * id rather than carrying the source's, so the two events cannot end up contending for one
     * URL — and the seeded source is genuinely live at that URL, so this is a difference rather
     * than two absent pages.
     */
    const destinationPage = await publishing.preview(actor, destinationId);
    expect(destinationPage).toMatchObject({ state: "draft", published: null, publishedAt: null });
    expect(destinationPage?.slug).not.toBe(SOURCE_SLUG);
    expect(destinationPage?.draft.event.slug).not.toBe(SOURCE_SLUG);
    expect(destinationPage?.draft.event.slug).toBe(destinationPage?.slug);
    await expect(publishing.preview(actor, SOURCE)).resolves.toMatchObject({
      state: "published",
      slug: SOURCE_SLUG,
    });
    // The venue and summary are the two fields the template does carry, so the page is a real
    // copy rather than an empty row that trivially satisfies everything above.
    expect(destinationPage?.draft.event).toMatchObject({
      summary: "A practical gathering for people building thoughtful, inclusive events.",
      venue: "Harbor Conference Center, Oakland",
      startsOn: DESTINATION_RANGE.startsOn,
      endsOn: DESTINATION_RANGE.endsOn,
    });
    // And nobody came with it: the gallery and the programme are the destination's own, empty.
    expect(destinationPage?.draft.sessions).toEqual([]);
    expect(destinationPage?.draft.speakers).toEqual([]);
  });
});
