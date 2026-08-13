// @acceptance ACC-EVENT-TEMPLATES
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CfpRepository } from "../src/adapters/persistence/d1-cfp-repository";
import type { D1DatabasePort } from "../src/adapters/persistence/d1-event-repository";
import { D1EventRepository } from "../src/adapters/persistence/d1-event-repository";
import { D1EventTemplateRepository } from "../src/adapters/persistence/d1-event-template-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import { D1SubmittedProposalAdapter } from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { CfpService } from "../src/application/cfp/cfp-service";
import { cfpTemplateSlice, CfpUnavailableError } from "../src/application/cfp/public";
import { EventService } from "../src/application/events/event-service";
import {
  EventTemplateNameTakenError,
  EventTemplateService,
} from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { createMigratedDatabase } from "./support/seeded-d1";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

const CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
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
  const cfp = new CfpService(
    new D1CfpRepository(database as ConstructorParameters<typeof D1CfpRepository>[0]),
    newId,
    now,
    new D1SubmittedProposalAdapter(
      database as ConstructorParameters<typeof D1SubmittedProposalAdapter>[0],
    ),
  );
  const repository = new D1EventTemplateRepository(database);
  return {
    cfp,
    events,
    identity,
    repository,
    templates: new EventTemplateService({
      repository,
      events,
      slices: [cfpTemplateSlice(cfp)],
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
    const { actor, cfp, database, destinationId, templates } = await seeded();
    const tables = await presentTables(database);
    // The sweep is only meaningful if the source is genuinely populated, so prove it is.
    const before = await rowCounts(database, tables);
    expect(before.cfp_submissions).toBeGreaterThan(0);
    expect(before.speaker_profiles).toBeGreaterThan(0);
    expect(before.review_assignments).toBeGreaterThan(0);

    const { template } = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Regional summit starter",
      sourceEventId: SOURCE,
    });
    await templates.apply(actor, destinationId, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });
    const after = await rowCounts(database, tables);

    /*
     * Driven from `table-ownership.json` rather than from a hand-written list, so a table added
     * later cannot quietly escape the check: any new table an apply writes to shows up here as
     * an unexpected name until somebody decides it belongs.
     */
    const changed = tables.filter((table) => after[table] !== before[table]);
    expect(changed.sort()).toEqual(
      [
        "cfp_forms",
        "event_template_applications",
        "event_template_versions",
        "event_templates",
      ].sort(),
    );

    /*
     * And per event: of every table that can name an event, only the two the clone is allowed to
     * touch hold a row for the destination, plus the single organizer grant its creation made.
     * No submission, evaluation, decision, person, private file, comment, delivery, itinerary or
     * audit row followed the configuration across.
     */
    const expectedForDestination: Record<string, number> = {
      cfp_forms: 1,
      event_roles: 1,
      event_template_applications: 1,
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
  });
});
