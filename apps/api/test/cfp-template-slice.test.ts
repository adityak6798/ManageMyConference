// @acceptance ACC-EVENT-TEMPLATES
/*
 * CFP's slice with review's slice in front of it, which is the composition the composition root
 * builds and the only one where a routing rule's status can arrive during the clone. The single
 * slice tests in `event-templates.test.ts` cannot reach this: they run CFP against a destination
 * nothing else is writing to, so a preview reading the destination as it stands is right there
 * and wrong here.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { CfpService } from "../src/application/cfp/cfp-service";
import { cfpTemplateSlice } from "../src/application/cfp/public";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { reviewTemplateSlice } from "../src/application/review/public";
import { ReviewService } from "../src/application/review/review-service";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";

const ORGANIZER_CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "review:manage",
] as const satisfies readonly Capability[];

const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

const RESERVED = [
  { key: "accepted", label: "Accepted", sortOrder: 90 },
  { key: "declined", label: "Declined", sortOrder: 91 },
];

const FIELDS = [
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

const routingRule = (id: string, status: string) => ({
  id,
  when: { fieldId: "track", operator: "equals" as const, values: ["Platform"] },
  routeTo: { status },
});

function organizer(): Actor {
  return {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [{ id: ORGANIZATION }],
    eventAccess: [SOURCE, DESTINATION].map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
    })),
    capabilities: new Set<Capability>(ORGANIZER_CAPABILITIES),
  };
}

async function setup(options: { readonly destinationProposalStatus?: string } = {}) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const eventRepository = new MemoryEventRepository();
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
  const events = new EventService({ repository: eventRepository, newId, now });

  // One status store behind both domains, exactly as production has it: review writes the set
  // through `configureStatuses` and CFP reads the same rows through `routingStatuses`.
  const proposals = new MemorySubmittedProposalAdapter(
    options.destinationProposalStatus
      ? [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            eventId: DESTINATION,
            title: "An abstract the destination already holds",
            abstract: "",
            submitterName: "Applicant",
            submitter: null,
            answers: [],
            status: options.destinationProposalStatus,
          },
        ]
      : [],
  );
  const cfp = new CfpService(new MemoryCfpRepository(), newId, now, proposals);
  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals,
    identities: {
      isReviewerForEvent: async () => false,
      listReviewersForEvent: async () => [],
    },
    events,
    newId,
    now,
  });

  const templates = new EventTemplateService({
    repository: new MemoryEventTemplateRepository(),
    events,
    // The composition root's order, and the reason this file exists: review's statuses land
    // before CFP validates its rules against them.
    slices: [reviewTemplateSlice(review), cfpTemplateSlice(cfp)],
    newId,
    now,
  });
  return { actor: organizer(), cfp, proposals, review, templates };
}

const capture = (templates: EventTemplateService, actor: Actor) =>
  templates.saveFromEvent(actor, {
    organizationId: ORGANIZATION,
    name: "Annual summit starter",
    sourceEventId: SOURCE,
  });

const previewInto = (templates: EventTemplateService, actor: Actor, templateId: string) =>
  templates.preview(actor, DESTINATION, {
    templateId,
    version: 1,
    destination: DESTINATION_RANGE,
  });

const applyInto = (templates: EventTemplateService, actor: Actor, templateId: string) =>
  templates.apply(actor, DESTINATION, {
    templateId,
    version: 1,
    destination: DESTINATION_RANGE,
  });

const cfpSlice = <T extends { readonly key: string }>(slices: readonly T[]) =>
  slices.find(({ key }) => key === "cfp");

const reviewSlice = <T extends { readonly key: string }>(slices: readonly T[]) =>
  slices.find(({ key }) => key === "review");

describe("CFP template slice, applied behind the triage statuses", () => {
  it("previews a rule whose status review is about to create as copied, and copies it", async () => {
    const { actor, cfp, proposals, review, templates } = await setup();
    await review.configureStatuses(actor, SOURCE, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "shortlisted", label: "Shortlisted", sortOrder: 1 },
      ...RESERVED,
    ]);
    await cfp.save(actor, {
      eventId: SOURCE,
      title: "Share your conference story",
      description: "Submit a practical session.",
      fields: FIELDS,
      routing: [routingRule("route-shortlist", "shortlisted")],
      expectedVersion: 0,
    });
    // A destination nobody has configured yet, which is the state a freshly created event is in.
    await proposals.saveStatuses(DESTINATION, []);
    const { template } = await capture(templates, actor);

    const plan = await previewInto(templates, actor, template.id);
    const result = await applyInto(templates, actor, template.id);

    const previewed = cfpSlice(plan.slices);
    const applied = cfpSlice(result.slices);
    // The property that was broken: the rule is on one side of the preview and the same side of
    // the result, rather than incompatible before and applied after.
    expect(previewed?.copies.map(({ id }) => id)).toContain("route-shortlist");
    expect(previewed?.incompatible).toEqual([]);
    expect(applied?.applied.map(({ id }) => id)).toContain("route-shortlist");
    expect(applied?.incompatible).toEqual([]);
    // The dependency is stated rather than left for the organizer to infer from the label alone.
    expect(previewed?.copies.find(({ id }) => id === "route-shortlist")?.label).toContain(
      "triage statuses",
    );
    expect(previewed?.reason).toContain("triage statuses the review category writes first");
    expect((await cfp.getForOrganizer(actor, DESTINATION))?.routing?.map(({ id }) => id)).toEqual([
      "route-shortlist",
    ]);
  });

  /*
   * Review answers `incompatible` in two situations that are opposites for this slice, and no
   * reading of that verdict can separate them — which is why the seam carries a promise the
   * review slice makes about itself instead. Here review refuses its whole status set because the
   * destination's own abstracts hold a status the template omits, so nothing is written and the
   * rule must stay refused on both sides. The sibling case above is the other one: a rubric locked
   * by existing assignments, also `incompatible`, where the status set lands and the rule copies.
   */
  it("refuses a rule when review reports incompatible and writes no statuses at all", async () => {
    const { actor, cfp, proposals, review, templates } = await setup({
      // The destination holds an abstract in a status of its own, so applying the template's set
      // would strand it — which review refuses, whole.
      destinationProposalStatus: "withdrawn",
    });
    await review.configureStatuses(actor, SOURCE, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "shortlisted", label: "Shortlisted", sortOrder: 1 },
      ...RESERVED,
    ]);
    await cfp.save(actor, {
      eventId: SOURCE,
      title: "Share your conference story",
      description: "Submit a practical session.",
      fields: FIELDS,
      routing: [routingRule("route-shortlist", "shortlisted")],
      expectedVersion: 0,
    });
    await proposals.saveStatuses(DESTINATION, [
      { key: "withdrawn", label: "Withdrawn", sortOrder: 0 },
      ...RESERVED,
    ]);
    const { template } = await capture(templates, actor);
    const statusWrites = vi.spyOn(proposals, "saveStatuses");

    const plan = await previewInto(templates, actor, template.id);
    const result = await applyInto(templates, actor, template.id);

    const previewed = cfpSlice(plan.slices);
    const applied = cfpSlice(result.slices);
    expect(reviewSlice(plan.slices)?.outcome).toBe("incompatible");
    expect(statusWrites).not.toHaveBeenCalled();
    // Both sides refuse it, which is the agreement the promise exists to keep.
    expect(previewed?.incompatible.map(({ id }) => id)).toContain("route-shortlist");
    expect(previewed?.copies.map(({ id }) => id)).not.toContain("route-shortlist");
    expect(applied?.incompatible.map(({ id }) => id)).toContain("route-shortlist");
    expect((await cfp.getForOrganizer(actor, DESTINATION))?.routing ?? []).toEqual([]);
  });

  it("still refuses a rule whose status nothing in this clone creates", async () => {
    const { actor, cfp, proposals, review, templates } = await setup();
    await review.configureStatuses(actor, SOURCE, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "shortlisted", label: "Shortlisted", sortOrder: 1 },
      ...RESERVED,
    ]);
    await cfp.save(actor, {
      eventId: SOURCE,
      title: "Share your conference story",
      description: "Submit a practical session.",
      fields: FIELDS,
      routing: [routingRule("route-shortlist", "shortlisted")],
      expectedVersion: 0,
    });
    await proposals.saveStatuses(DESTINATION, []);
    const { template } = await capture(templates, actor);

    // Review deselected: nothing writes the statuses, so the destination is the one it looks.
    const command = {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
      slices: ["cfp"],
    };
    const plan = await templates.preview(actor, DESTINATION, command);
    const result = await templates.apply(actor, DESTINATION, command);

    expect(cfpSlice(plan.slices)?.incompatible.map(({ id }) => id)).toEqual(["route-shortlist"]);
    expect(cfpSlice(plan.slices)?.copies.map(({ id }) => id)).not.toContain("route-shortlist");
    expect(cfpSlice(result.slices)?.incompatible.map(({ id }) => id)).toEqual(["route-shortlist"]);
    expect((await cfp.getForOrganizer(actor, DESTINATION))?.routing).toEqual([]);
  });

  it("says whose status set decides, for a rule the destination configures and review drops", async () => {
    const { actor, cfp, proposals, review, templates } = await setup();
    await review.configureStatuses(actor, SOURCE, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "partner_track", label: "Partner track", sortOrder: 1 },
      ...RESERVED,
    ]);
    await cfp.save(actor, {
      eventId: SOURCE,
      title: "Share your conference story",
      description: "Submit a practical session.",
      fields: FIELDS,
      routing: [routingRule("route-partner", "partner_track")],
      expectedVersion: 0,
    });
    // The source retires the status afterwards, which leaves its form holding a rule the source
    // itself no longer configures — and leaves review's payload without the status the rule names.
    await review.configureStatuses(actor, SOURCE, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      ...RESERVED,
    ]);
    // The destination configures it today, so reading the destination alone says "copied".
    await proposals.saveStatuses(DESTINATION, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "partner_track", label: "Partner track", sortOrder: 1 },
      ...RESERVED,
    ]);
    const { template } = await capture(templates, actor);

    const plan = await previewInto(templates, actor, template.id);
    const result = await applyInto(templates, actor, template.id);

    /*
     * The preview cannot promise this rule, and does not: review's payload never crosses into
     * this slice, so the honest answer is which status set the rule will be checked against. The
     * organizer reads that sentence, then reads the same set named in the refusal.
     */
    expect(cfpSlice(plan.slices)?.reason).toContain(
      "checked against the triage statuses the review category writes first",
    );
    expect(cfpSlice(result.slices)?.incompatible.map(({ id }) => id)).toEqual(["route-partner"]);
    expect((await cfp.getForOrganizer(actor, DESTINATION))?.routing).toEqual([]);
    expect((await review.organizerWorkspace(actor, DESTINATION)).statuses).not.toContainEqual(
      expect.objectContaining({ key: "partner_track" }),
    );
  });
});

/*
 * The stored payload, read as the untrusted input it is. Every case below is a form the HTTP
 * composer's schema would have refused, reaching `apply` through a table an operator can edit.
 */
describe("CFP template slice: a hand-edited payload", () => {
  // The CFP payload carries no instants, so the remap is inert here; it is the parameter the port
  // declares, not something this slice reads.
  const REMAP = {
    destination: { ...DESTINATION_RANGE, eventId: DESTINATION, timezone: "UTC" },
    source: { eventId: SOURCE, timezone: "UTC" },
  };
  const slice = cfpTemplateSlice({
    getForOrganizer: async () => null,
    routingStatuses: async () => [],
    save: () => {
      throw new Error("The payload should never have reached a write");
    },
  });

  const form = (overrides: Record<string, unknown>) => ({
    title: "Share your conference story",
    description: "Submit a practical session.",
    fields: FIELDS,
    routing: [],
    ...overrides,
  });

  const refuses = (payload: unknown) =>
    expect(slice.apply(organizer(), DESTINATION, payload, REMAP)).rejects.toThrow(
      "could not be read",
    );

  it("refuses a form with no questions, or with more than the composer allows", async () => {
    await refuses(form({ fields: [] }));
    await refuses(
      form({
        fields: Array.from({ length: 41 }, (_, index) => ({ ...FIELDS[0], id: `q${index}` })),
      }),
    );
  });

  it("refuses duplicate field ids, which answers cannot be keyed by", async () => {
    await refuses(form({ fields: [FIELDS[0], { ...FIELDS[1], id: "title" }] }));
  });

  it("refuses a select with nothing to select", async () => {
    await refuses(form({ fields: [FIELDS[0], { ...FIELDS[1], options: [] }] }));
  });

  it("refuses a condition on a question the applicant has not been asked yet", async () => {
    const condition = { fieldId: "track", operator: "equals" as const, values: ["Platform"] };
    await refuses(form({ fields: [{ ...FIELDS[0], visibleWhen: condition }, FIELDS[1]] }));
    // Its own answer is no earlier than itself, so a self-reference is the same refusal.
    await refuses(
      form({ fields: [{ ...FIELDS[0], visibleWhen: { ...condition, fieldId: "title" } }] }),
    );
  });

  it("refuses a title that is empty or past the composer's ceiling", async () => {
    await refuses(form({ title: "   " }));
    await refuses(form({ title: "x".repeat(121) }));
  });

  it("refuses a routing rule routing on a question this form does not ask", async () => {
    await refuses(
      form({ routing: [routingRule("route-ghost", "submitted")], fields: [FIELDS[0]] }),
    );
  });

  it("refuses duplicate routing rule ids", async () => {
    await refuses(
      form({
        routing: [routingRule("route-one", "submitted"), routingRule("route-one", "submitted")],
      }),
    );
  });
});
