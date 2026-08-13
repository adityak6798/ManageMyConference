// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { CfpService } from "../src/application/cfp/cfp-service";
import { cfpTemplateSlice } from "../src/application/cfp/public";
import { EventService } from "../src/application/events/event-service";
import {
  EventTemplateNameTakenError,
  EventTemplateNotFoundError,
  EventTemplateRangeError,
  EventTemplateService,
  EventTemplateStateError,
} from "../src/application/events/public";
import type {
  EventConfigurationSlice,
  SlicePreview,
  SliceResult,
} from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { CapabilityDeniedError } from "../src/application/identity/actor";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000020";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const OUTSIDE = "00000000-0000-4000-8000-000000000099";

const ORGANIZER_CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
] as const satisfies readonly Capability[];

const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

function organizer(eventIds: readonly string[], organizationId = ORGANIZATION): Actor {
  return {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [{ id: organizationId }],
    eventAccess: eventIds.map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
    })),
    capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
  };
}

const SEEDED_FIELDS = [
  {
    id: "title",
    type: "short_text" as const,
    label: "Proposal title",
    guidance: "Keep it specific",
    required: true,
    options: [] as string[],
  },
  {
    id: "track",
    type: "select" as const,
    label: "Track",
    guidance: "",
    required: false,
    options: ["Platform", "Practice"],
  },
];

async function setup(
  options: {
    routing?: { id: string; status: string }[];
    sourceStatuses?: { key: string; label: string; sortOrder: number }[];
  } = {},
) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const eventRepository = new MemoryEventRepository();
  for (const [id, organizationId, name] of [
    [SOURCE, ORGANIZATION, "Greenroom Demo Summit"],
    [DESTINATION, ORGANIZATION, "Greenroom Demo Summit 2027"],
    [OUTSIDE, OTHER_ORGANIZATION, "Private Outside Event"],
  ] as const)
    await eventRepository.create({
      id,
      organizationId,
      name,
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  const events = new EventService({ repository: eventRepository, newId, now });

  const proposals = new MemorySubmittedProposalAdapter();
  const cfpRepository = new MemoryCfpRepository();
  const cfp = new CfpService(cfpRepository, newId, now, proposals);

  const actor = organizer([SOURCE, DESTINATION]);
  if (options.sourceStatuses) await proposals.saveStatuses(SOURCE, options.sourceStatuses);
  await cfp.save(actor, {
    eventId: SOURCE,
    title: "Share your conference story",
    description: "Submit a practical session.",
    fields: SEEDED_FIELDS,
    routing: (options.routing ?? []).map(({ id, status }) => ({
      id,
      when: { fieldId: "track", operator: "equals" as const, values: ["Platform"] },
      routeTo: { status },
    })),
    expectedVersion: 0,
  });
  // The source's CFP is live. Nothing below may carry that fact into the destination.
  await cfp.changeState(actor, SOURCE, "publish");

  const repository = new MemoryEventTemplateRepository();
  const templates = new EventTemplateService({
    repository,
    events,
    slices: [cfpTemplateSlice(cfp)],
    newId,
    now,
  });
  return { actor, cfp, cfpRepository, events, repository, templates, proposals };
}

const save = (templates: EventTemplateService, actor: Actor, name = "Annual summit starter") =>
  templates.saveFromEvent(actor, { organizationId: ORGANIZATION, name, sourceEventId: SOURCE });

describe("Event templates: capture", () => {
  it("captures each domain's own configuration and reports what every category contributed", async () => {
    const { actor, templates } = await setup();

    const capture = await save(templates, actor);

    expect(capture.template).toMatchObject({ organizationId: ORGANIZATION, state: "active" });
    expect(capture.version.version).toBe(1);
    expect(capture.version.sourceEventId).toBe(SOURCE);
    expect(capture.version.createdBy).toBe("seed-organizer");
    expect(capture.slices).toEqual([
      {
        key: "cfp",
        label: "CFP form and routing",
        outcome: "captured",
        reason: expect.any(String),
      },
    ]);
    // The payload holds the editable form and nothing about its publication.
    expect(capture.version.payload.slices.cfp).toEqual({
      title: "Share your conference story",
      description: "Submit a practical session.",
      fields: SEEDED_FIELDS,
      routing: [],
    });
    expect(JSON.stringify(capture.version.payload)).not.toContain("publishedAt");
  });

  it("records provenance so an event's version is a stored fact rather than a claim", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);

    const second = await templates.captureVersion(actor, template.id, SOURCE);

    expect(second.version.version).toBe(2);
    const detail = await templates.get(actor, template.id);
    expect(detail.versions.map(({ version }) => version)).toEqual([2, 1]);
    expect(detail.versions[0]?.payload.source).toEqual({
      eventId: SOURCE,
      eventName: "Greenroom Demo Summit",
      timezone: "America/Los_Angeles",
    });
  });

  it("refuses a second active template with the same name, and frees the name on archive", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);

    await expect(save(templates, actor)).rejects.toBeInstanceOf(EventTemplateNameTakenError);

    await templates.archive(actor, template.id, true);
    await expect(save(templates, actor)).resolves.toMatchObject({
      template: { name: "Annual summit starter" },
    });
  });

  it("duplicates the newest version into a new template without inventing history", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);
    await templates.captureVersion(actor, template.id, SOURCE);

    const copy = await templates.duplicate(actor, template.id, "Regional summit starter");

    expect(copy.template.id).not.toBe(template.id);
    expect(copy.version.version).toBe(1);
    expect(copy.version.payload.slices.cfp).toEqual(
      (await templates.get(actor, template.id)).versions[0]?.payload.slices.cfp,
    );
    // Exactly one version, so nothing re-stamps the two the original actually lived.
    expect((await templates.get(actor, copy.template.id)).versions).toHaveLength(1);
  });

  it("refuses a source event outside the template's organization", async () => {
    const { templates } = await setup();
    const stranger = organizer([SOURCE, OUTSIDE]);

    await expect(
      templates.saveFromEvent(stranger, {
        organizationId: ORGANIZATION,
        name: "Borrowed",
        sourceEventId: OUTSIDE,
      }),
    ).rejects.toBeInstanceOf(EventTemplateNotFoundError);
  });
});

describe("Event templates: preview", () => {
  it("lists every copied and excluded category and writes nothing", async () => {
    const { actor, cfp, templates } = await setup();
    const { template } = await save(templates, actor);

    const plan = await templates.preview(actor, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    const cfpSlice = plan.slices.find(({ key }) => key === "cfp");
    expect(cfpSlice?.outcome).toBe("copies");
    expect(cfpSlice?.copies.map(({ id }) => id)).toEqual(["form", "title", "track"]);
    expect(cfpSlice?.excludes.map(({ id }) => id)).toEqual(["published", "submissions"]);
    // The category the issue names that this system copies nothing for is reported, not omitted.
    const communications = plan.slices.find(({ key }) => key === "communications");
    expect(communications?.outcome).toBe("skipped");
    expect(communications?.reason).toContain("Already shared at the organization");
    expect(plan.sourceEventName).toBe("Greenroom Demo Summit");
    await expect(cfp.getForOrganizer(actor, DESTINATION)).resolves.toBeNull();
  });

  it("refuses a destination range that is malformed or ends before it starts", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);
    const command = { templateId: template.id, version: 1 };

    await expect(
      templates.preview(actor, DESTINATION, {
        ...command,
        destination: { startsOn: "2027-05-12", endsOn: "2027-05-10" },
      }),
    ).rejects.toBeInstanceOf(EventTemplateRangeError);
    await expect(
      templates.preview(actor, DESTINATION, {
        ...command,
        destination: { startsOn: "2027-02-31", endsOn: "2027-03-01" },
      }),
    ).rejects.toBeInstanceOf(EventTemplateRangeError);
  });
});

describe("Event templates: apply", () => {
  const apply = (templates: EventTemplateService, actor: Actor, templateId: string) =>
    templates.apply(actor, DESTINATION, {
      templateId,
      version: 1,
      destination: DESTINATION_RANGE,
    });

  it("copies the CFP as a draft, carrying no publication over", async () => {
    const { actor, cfp, templates } = await setup();
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(result.outcome).toBe("applied");
    expect(result.slices.find(({ key }) => key === "cfp")?.outcome).toBe("applied");
    const copied = await cfp.getForOrganizer(actor, DESTINATION);
    expect(copied).toMatchObject({
      eventId: DESTINATION,
      title: "Share your conference story",
      fields: SEEDED_FIELDS,
      status: "draft",
      publishedAt: null,
      publishedStatus: null,
    });
  });

  it("converges: a second application leaves the destination byte-identical", async () => {
    const { actor, cfp, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);
    const afterFirst = await cfp.getForOrganizer(actor, DESTINATION);
    const second = await apply(templates, actor, template.id);
    const afterSecond = await cfp.getForOrganizer(actor, DESTINATION);

    expect(second.outcome).toBe("applied");
    // Byte-identical, version counter included: the slice compares before it writes rather than
    // advancing optimistic concurrency for a change nobody made.
    expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst));
  });

  it("records one application row per (event, version) however often it is applied", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);
    await apply(templates, actor, template.id);

    await expect(templates.applications(actor, DESTINATION)).resolves.toEqual([
      {
        templateId: template.id,
        templateName: "Annual summit starter",
        templateVersionId: expect.any(String),
        version: 1,
        appliedAt: "2026-08-12T10:00:00.000Z",
      },
    ]);
  });

  it("copies the rules the destination can accept and names the ones it cannot", async () => {
    // The source configured an extra triage status; the destination has only the defaults, which
    // is exactly the ordering constraint review's slice will remove.
    const { actor, cfp, templates } = await setup({
      routing: [
        { id: "rule-platform", status: "under_review" },
        { id: "rule-partner", status: "partner_track" },
      ],
      sourceStatuses: [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "under_review", label: "Under review", sortOrder: 1 },
        { key: "partner_track", label: "Partner track", sortOrder: 2 },
      ],
    });
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    const slice = result.slices.find(({ key }) => key === "cfp");
    expect(slice?.outcome).toBe("applied");
    expect(slice?.incompatible.map(({ id }) => id)).toEqual(["rule-partner"]);
    const copied = await cfp.getForOrganizer(actor, DESTINATION);
    expect(copied?.routing?.map(({ id }) => id)).toEqual(["rule-platform"]);
  });

  it("clones only the categories the caller selected", async () => {
    const { actor, cfp, templates } = await setup();
    const { template } = await save(templates, actor);

    const result = await templates.apply(actor, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
      slices: [],
    });

    expect(result.slices.find(({ key }) => key === "cfp")).toMatchObject({
      outcome: "skipped",
      reason: "Not selected for this clone.",
    });
    await expect(cfp.getForOrganizer(actor, DESTINATION)).resolves.toBeNull();
  });

  it("refuses an archived template", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);
    await templates.archive(actor, template.id, true);

    await expect(apply(templates, actor, template.id)).rejects.toBeInstanceOf(
      EventTemplateStateError,
    );
  });

  it("answers a foreign organization's template exactly as an unknown one", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);
    const outsider = organizer([OUTSIDE], OTHER_ORGANIZATION);

    const foreign = templates.apply(outsider, OUTSIDE, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });
    const unknown = templates.apply(outsider, OUTSIDE, {
      templateId: "00000000-0000-4000-8000-00000000dead",
      version: 1,
      destination: DESTINATION_RANGE,
    });

    await expect(foreign).rejects.toBeInstanceOf(EventTemplateNotFoundError);
    await expect(unknown).rejects.toBeInstanceOf(EventTemplateNotFoundError);
    await expect(foreign).rejects.toThrow("No such event template");
    await expect(unknown).rejects.toThrow("No such event template");
  });

  it("refuses an actor with no grant on the destination event", async () => {
    const { actor, templates } = await setup();
    const { template } = await save(templates, actor);
    const sourceOnly = organizer([SOURCE]);

    await expect(apply(templates, sourceOnly, template.id)).rejects.toThrow(
      "Actor lacks events:settings:update for event",
    );
  });
});

/*
 * The orchestration contract, driven through stub slices rather than through CFP.
 *
 * These are the cases the seam exists to handle and that no single-slice composition can reach:
 * CFP's own write capability is the same `events:settings:update` the orchestrator has already
 * checked, so a denied CFP slice is unreachable while it is the only slice. Reviewing, agenda,
 * publishing and content each demand something else, and the behaviour they will rely on —
 * refusal reported per category, one failure not taking the others with it, and `partial` said
 * out loud — is asserted here now rather than after they arrive.
 */
describe("Event templates: the per-slice contract", () => {
  function stubSlice(key: string, behaviour: () => never | Promise<SliceResult>) {
    const entries = [{ id: key, label: key }];
    return {
      key,
      label: key,
      async export() {
        return { captured: key };
      },
      async preview(): Promise<SlicePreview> {
        return {
          outcome: "copies" as const,
          reason: "",
          copies: entries,
          excludes: [],
          incompatible: [],
        };
      },
      apply: async () => behaviour(),
    };
  }

  const working = stubSlice("working", async () => ({
    outcome: "applied" as const,
    reason: "Copied.",
    applied: [{ id: "working", label: "working" }],
    incompatible: [],
  }));

  async function applyWith(slices: EventConfigurationSlice[]) {
    const eventRepository = new MemoryEventRepository();
    for (const [id, organizationId] of [
      [SOURCE, ORGANIZATION],
      [DESTINATION, ORGANIZATION],
    ] as const)
      await eventRepository.create({
        id,
        organizationId,
        name: id,
        timezone: "UTC",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
    let sequence = 0;
    const templates = new EventTemplateService({
      repository: new MemoryEventTemplateRepository(),
      events: new EventService({
        repository: eventRepository,
        newId: crypto.randomUUID,
        now: () => new Date(),
      }),
      slices,
      newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      now: () => new Date("2026-08-12T10:00:00.000Z"),
    });
    const actor = organizer([SOURCE, DESTINATION]);
    const { template } = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Stubbed",
      sourceEventId: SOURCE,
    });
    return templates.apply(actor, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });
  }

  it("reports a category the actor may not write as unauthorized, and applies the rest", async () => {
    const denied = stubSlice("denied", () => {
      throw new CapabilityDeniedError("Actor lacks agenda:manage for event");
    });

    const result = await applyWith([working, denied]);

    expect(result.outcome).toBe("applied");
    expect(result.slices.map(({ key, outcome }) => [key, outcome])).toEqual([
      ["working", "applied"],
      ["denied", "unauthorized"],
      ["communications", "skipped"],
    ]);
  });

  it("says partial when one category fails, and does not roll back the ones that landed", async () => {
    const broken = stubSlice("broken", () => {
      throw new Error("The destination rubric is locked by existing assignments");
    });

    const result = await applyWith([working, broken]);

    expect(result.outcome).toBe("partial");
    expect(result.slices.find(({ key }) => key === "working")?.outcome).toBe("applied");
    expect(result.slices.find(({ key }) => key === "broken")).toMatchObject({
      outcome: "failed",
      reason: "The destination rubric is locked by existing assignments",
    });
  });

  it("says failed when nothing landed at all", async () => {
    const broken = stubSlice("broken", () => {
      throw new Error("Storage is unreachable");
    });

    await expect(applyWith([broken])).resolves.toMatchObject({ outcome: "failed" });
  });
});
