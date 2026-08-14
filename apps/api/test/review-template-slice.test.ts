// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import type { SubmittedProposal } from "../src/application/cfp/submitted-proposal-interface";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService, SliceRefusalError } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { reviewTemplateSlice } from "../src/application/review/public";
import { ReviewService } from "../src/application/review/review-service";
import type { ReviewCriterion } from "../src/domain/review/review";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const PROPOSAL = "10000000-0000-4000-8000-000000000001";
const REVIEWER = "seed-reviewer";

const ORGANIZER_CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "review:manage",
] as const satisfies readonly Capability[];

const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

/** The source's triage pipeline, including the two reserved keys every event carries. */
const SOURCE_STATUSES = [
  { key: "submitted", label: "Submitted", sortOrder: 0 },
  { key: "screening", label: "Screening", sortOrder: 1 },
  { key: "shortlisted", label: "Shortlisted", sortOrder: 2 },
  { key: "accepted", label: "Accepted", sortOrder: 90 },
  { key: "declined", label: "Declined", sortOrder: 91 },
];

// A weighted criterion and a dropdown alongside the plain numeric one, so the round trip proves
// the payload survives every criterion shape rather than the simplest.
const SOURCE_CRITERIA: readonly ReviewCriterion[] = [
  { id: "fit", name: "Audience fit", description: "How well it lands", minScore: 1, maxScore: 5 },
  {
    id: "novelty",
    name: "Novelty",
    description: "Have we heard this before",
    minScore: 1,
    maxScore: 5,
    weight: 2,
  },
  {
    id: "track",
    name: "Suggested track",
    description: "Where it belongs",
    type: "dropdown",
    options: ["Platform", "Practice"],
  },
];

const DESTINATION_CRITERIA: readonly ReviewCriterion[] = [
  { id: "clarity", name: "Clarity", description: "Is it legible", minScore: 1, maxScore: 3 },
];

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

const submitted = (eventId: string, status: string): SubmittedProposal => ({
  id: PROPOSAL,
  eventId,
  title: "Test proposal",
  abstract: "Test abstract",
  submitterName: "Robin Submitter",
  submitterUserId: null,
  submitter: { name: "Robin Submitter", email: "robin@example.test" },
  answers: [],
  status,
});

async function setup(options: { destination?: readonly SubmittedProposal[] } = {}) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  let clock = new Date("2026-08-12T10:00:00.000Z");
  const now = () => clock;

  const templateRepository = new MemoryEventTemplateRepository();
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

  const proposals = new MemorySubmittedProposalAdapter(options.destination ?? []);
  /*
   * Every status write, counted at the storage seam.
   *
   * "The second apply wrote nothing" is a claim about calls, and comparing stored rows cannot
   * make it: `saveStatuses` rewrites the same three fields, so a redundant write leaves storage
   * looking exactly as it did. The rubric's `updatedAt` is the witness on that half; this is the
   * witness on this one.
   */
  const statusWrites: string[] = [];
  const saveStatuses = proposals.saveStatuses.bind(proposals);
  proposals.saveStatuses = async (eventId, statuses) => {
    statusWrites.push(eventId);
    await saveStatuses(eventId, statuses);
  };

  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals,
    identities: {
      isReviewerForEvent: async (userId) => userId === REVIEWER,
      listReviewersForEvent: async () => [{ id: REVIEWER, name: "Ravi Reviewer" }],
    },
    events,
    newId,
    now,
  });

  const actor = organizer([SOURCE, DESTINATION]);
  await review.configureStatuses(actor, SOURCE, SOURCE_STATUSES);
  await review.configurePlan(actor, SOURCE, SOURCE_CRITERIA);

  const templates = new EventTemplateService({
    repository: templateRepository,
    events,
    slices: [reviewTemplateSlice(review)],
    newId,
    now,
  });
  return {
    actor,
    advance: (at: string) => {
      clock = new Date(at);
    },
    proposals,
    review,
    statusWrites,
    templateRepository,
    templates,
  };
}

const save = (templates: EventTemplateService, actor: Actor) =>
  templates.saveFromEvent(actor, {
    organizationId: ORGANIZATION,
    name: "Annual summit starter",
    sourceEventId: SOURCE,
  });

const applyTo = (templates: EventTemplateService, actor: Actor, templateId: string) =>
  templates.apply(actor, DESTINATION, {
    templateId,
    version: 1,
    destination: DESTINATION_RANGE,
  });

const reviewSlice = <T extends { readonly key: string }>(slices: readonly T[]) =>
  slices.find(({ key }) => key === "review");

describe("Review template slice", () => {
  it("captures the statuses and the rubric, and applies them into another event", async () => {
    const { actor, proposals, review, statusWrites, templates } = await setup();

    const capture = await save(templates, actor);

    expect(capture.slices).toEqual([
      {
        key: "review",
        label: "Triage statuses and scoring rubric",
        outcome: "captured",
        reason: expect.any(String),
      },
    ]);
    // Configuration only: nothing about assignments, evaluations, decisions or rounds.
    expect(capture.version.payload.slices.review).toEqual({
      statuses: SOURCE_STATUSES,
      criteria: SOURCE_CRITERIA,
    });

    /*
     * The destination stores no statuses at all before the preview, and that is the whole point
     * of the two assertions below. A destination whose stored set already holds `accepted` and
     * `declined` — the memory adapter's default, and what the source event configured — gives the
     * organizer projection nothing to repair, so "the preview wrote nothing" would pass whether
     * or not the preview reads through a repairing query. An event nobody has configured yet is
     * the state a brand-new destination is actually in, and the one where a repair is a write.
     */
    await proposals.saveStatuses(DESTINATION, []);
    const writesBeforePreview = statusWrites.length;
    const plan = await templates.preview(actor, DESTINATION, {
      templateId: capture.template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    const previewed = reviewSlice(plan.slices);
    expect(previewed?.outcome).toBe("copies");
    expect(previewed?.copies.map(({ id }) => id)).toEqual([
      "status:submitted",
      "status:screening",
      "status:shortlisted",
      "status:accepted",
      "status:declined",
      "criterion:fit",
      "criterion:novelty",
      "criterion:track",
    ]);
    // Every category present in the source and deliberately not copied is named, rounds included.
    expect(previewed?.excludes.map(({ id }) => id)).toEqual([
      "assignments",
      "evaluations",
      "conflicts",
      "outcomes",
      "decisions",
      "rounds",
      "status-audit",
    ]);
    expect(statusWrites.length).toBe(writesBeforePreview);
    // Read the same way the slice reads, so the check itself cannot be what repairs the set.
    const afterPreview = await review.reviewConfiguration(actor, DESTINATION);
    expect(afterPreview.statuses).toEqual([]);
    expect(afterPreview.plan).toBeNull();

    const result = await applyTo(templates, actor, capture.template.id);

    expect(result.outcome).toBe("applied");
    expect(reviewSlice(result.slices)?.outcome).toBe("applied");
    const workspace = await review.organizerWorkspace(actor, DESTINATION);
    expect(workspace.statuses).toEqual(SOURCE_STATUSES);
    expect(workspace.plan?.criteria).toEqual(SOURCE_CRITERIA);
    // The round trip closes: capturing the destination now yields the payload it was built from.
    const recaptured = await templates.saveFromEvent(actor, {
      organizationId: ORGANIZATION,
      name: "Round trip",
      sourceEventId: DESTINATION,
    });
    expect(recaptured.version.payload.slices.review).toEqual(capture.version.payload.slices.review);
  });

  it("converges: a second application writes nothing at all", async () => {
    const { actor, advance, review, statusWrites, templates } = await setup();
    const { template } = await save(templates, actor);

    await applyTo(templates, actor, template.id);
    const afterFirst = await review.organizerWorkspace(actor, DESTINATION);
    const writesAfterFirst = statusWrites.length;
    // A moving clock is what makes the second assertion mean something: the rubric stamps
    // `updatedAt` from it, so a redundant write would show up as an hour that passed.
    advance("2026-08-12T11:00:00.000Z");
    const second = await applyTo(templates, actor, template.id);
    const afterSecond = await review.organizerWorkspace(actor, DESTINATION);

    expect(second.outcome).toBe("applied");
    expect(reviewSlice(second.slices)).toMatchObject({
      outcome: "applied",
      reason: "Already identical to the template; nothing needed to be written.",
    });
    expect(statusWrites.length).toBe(writesAfterFirst);
    expect(afterSecond.plan?.updatedAt).toBe("2026-08-12T10:00:00.000Z");
    expect(JSON.stringify(afterSecond.statuses)).toBe(JSON.stringify(afterFirst.statuses));
  });

  it("reports a rubric locked by existing assignments as incompatible, and keeps the statuses", async () => {
    const { actor, review, templates } = await setup({
      destination: [submitted(DESTINATION, "submitted")],
    });
    await review.configurePlan(actor, DESTINATION, DESTINATION_CRITERIA);
    await review.assign(actor, DESTINATION, [PROPOSAL], REVIEWER);
    const { template } = await save(templates, actor);

    const result = await applyTo(templates, actor, template.id);

    const slice = reviewSlice(result.slices);
    expect(slice?.outcome).toBe("incompatible");
    expect(slice?.incompatible.map(({ id }) => id)).toEqual(["rubric"]);
    expect(slice?.reason).toContain("locked");
    const workspace = await review.organizerWorkspace(actor, DESTINATION);
    // The reviewers' criteria are the ones they were assigned under, still.
    expect(workspace.plan?.criteria).toEqual(DESTINATION_CRITERIA);
    // The statuses are not what the destination refused, so they landed.
    expect(slice?.applied.map(({ id }) => id)).toEqual([
      "status:submitted",
      "status:screening",
      "status:shortlisted",
      "status:accepted",
      "status:declined",
    ]);
    expect(workspace.statuses).toEqual(SOURCE_STATUSES);
    // A refusal is the organizer's answer, not a fault — and not a plain success either: the
    // statuses landed and the rubric did not, which is what `partial` says.
    expect(result.outcome).toBe("partial");
  });

  it("refuses a status set that drops a status the destination's abstracts hold", async () => {
    const { actor, review, statusWrites, templates } = await setup({
      destination: [submitted(DESTINATION, "withdrawn")],
    });
    const { template } = await save(templates, actor);
    const writesBefore = statusWrites.length;

    const result = await applyTo(templates, actor, template.id);

    const slice = reviewSlice(result.slices);
    expect(slice?.outcome).toBe("incompatible");
    expect(slice?.incompatible.map(({ id }) => id)).toEqual(["status:withdrawn"]);
    expect(statusWrites).toHaveLength(writesBefore);
    // The rubric is independent of the refusal, so it still landed.
    expect(slice?.applied.map(({ id }) => id)).toEqual([
      "criterion:fit",
      "criterion:novelty",
      "criterion:track",
    ]);
    expect((await review.organizerWorkspace(actor, DESTINATION)).plan?.criteria).toEqual(
      SOURCE_CRITERIA,
    );
  });
});

/*
 * The stored payload, read as the untrusted input it is.
 *
 * Every case below is a status set or a rubric the review composer would have refused —
 * `configureProposalStatusesInputSchema` and `configureReviewPlanInputSchema` state each bound —
 * reaching `apply` through a table an operator can edit rather than through those schemas. The
 * assertion is always the same pair: the category is refused, and the destination is left exactly
 * as it was found, both halves of it.
 */
describe("Review template slice: a hand-edited payload", () => {
  const NUMERIC = {
    id: "fit",
    name: "Audience fit",
    description: "How well it lands",
    minScore: 1,
    maxScore: 5,
  };
  const DROPDOWN = {
    id: "track",
    name: "Suggested track",
    description: "Where it belongs",
    type: "dropdown",
    options: ["Platform", "Practice"],
  };
  const TEXT = {
    id: "notes",
    name: "Notes",
    description: "Anything else",
    type: "text",
    maxLength: 500,
  };

  const status = (overrides: Record<string, unknown>) => ({
    key: "screening",
    label: "Screening",
    sortOrder: 1,
    ...overrides,
  });

  const criterion = (overrides: Record<string, unknown>) => ({ ...NUMERIC, ...overrides });

  /** A payload that differs from a legitimate capture in exactly the field under test. */
  const stored = (overrides: Record<string, unknown>) => ({
    statuses: SOURCE_STATUSES,
    criteria: [NUMERIC],
    ...overrides,
  });

  async function refuses(payload: unknown) {
    const { actor, review, statusWrites, templateRepository, templates } = await setup();
    const { template } = await save(templates, actor);
    const version = await templateRepository.findVersion(template.id, 1);
    // The stored row, as an operator with table access left it. Nothing between here and the
    // write re-validates it, which is why the slice's own reader has to.
    (version?.payload.slices as Record<string, unknown>).review = payload;
    const writesBefore = statusWrites.length;

    const result = await applyTo(templates, actor, template.id);

    const slice = reviewSlice(result.slices);
    expect(slice?.outcome).toBe("failed");
    expect(slice?.reason).toContain("could not be read");
    // Refused *rather than written*: a payload this reader turns down reaches neither command,
    // so the statuses the destination would have taken do not land either.
    expect(statusWrites.length).toBe(writesBefore);
    expect((await review.organizerWorkspace(actor, DESTINATION)).plan).toBeNull();
  }

  it("refuses more triage statuses than the composer would accept", async () => {
    await refuses(
      stored({
        statuses: Array.from({ length: 21 }, (_, index) => status({ key: `stage-${index}` })),
      }),
    );
  });

  it("refuses a status key no transition route could ever name", async () => {
    // Every route that moves an abstract parses the key with `proposalStatusSchema`, so a key
    // outside its alphabet is a column nothing can be moved into.
    await refuses(stored({ statuses: [status({ key: "Screening Pending" })] }));
    await refuses(stored({ statuses: [status({ key: "x".repeat(41) })] }));
    await refuses(stored({ statuses: [status({ key: "" })] }));
  });

  it("refuses a blank or oversized status label", async () => {
    await refuses(stored({ statuses: [status({ label: "   " })] }));
    await refuses(stored({ statuses: [status({ label: "x".repeat(81) })] }));
  });

  it("refuses a sort order that is not a whole non-negative number", async () => {
    await refuses(stored({ statuses: [status({ sortOrder: 1.5 })] }));
    await refuses(stored({ statuses: [status({ sortOrder: -1 })] }));
  });

  it("refuses more criteria than the composer would accept", async () => {
    await refuses(
      stored({
        criteria: Array.from({ length: 13 }, (_, index) => criterion({ id: `c-${index}` })),
      }),
    );
  });

  it("refuses a criterion id outside the alphabet, or past its ceiling", async () => {
    await refuses(stored({ criteria: [criterion({ id: "Audience Fit" })] }));
    await refuses(stored({ criteria: [criterion({ id: "x".repeat(41) })] }));
  });

  it("refuses a blank or oversized criterion name, and an oversized description", async () => {
    await refuses(stored({ criteria: [criterion({ name: "  " })] }));
    await refuses(stored({ criteria: [criterion({ name: "x".repeat(81) })] }));
    await refuses(stored({ criteria: [criterion({ description: "x".repeat(301) })] }));
  });

  it("refuses a weight outside the range the aggregate is defined over", async () => {
    await refuses(stored({ criteria: [criterion({ weight: 0 })] }));
    await refuses(stored({ criteria: [criterion({ weight: -2 })] }));
    await refuses(stored({ criteria: [criterion({ weight: 101 })] }));
  });

  it("refuses a numeric scale outside 0-10, or one with nowhere to go", async () => {
    await refuses(stored({ criteria: [criterion({ minScore: -1 })] }));
    await refuses(stored({ criteria: [criterion({ maxScore: 11 })] }));
    await refuses(stored({ criteria: [criterion({ minScore: 1.5 })] }));
    await refuses(stored({ criteria: [criterion({ minScore: 3, maxScore: 3 })] }));
    await refuses(stored({ criteria: [criterion({ minScore: 5, maxScore: 2 })] }));
  });

  it("refuses a dropdown with nothing to choose between", async () => {
    // A numeric criterion stands beside each one, so the refusal is this reader's rather than
    // `configurePlan`'s "at least one numeric criterion" answer to a rubric of one dropdown.
    await refuses(stored({ criteria: [NUMERIC, { ...DROPDOWN, options: [] }] }));
    await refuses(stored({ criteria: [NUMERIC, { ...DROPDOWN, options: ["Platform"] }] }));
    await refuses(
      stored({
        criteria: [
          NUMERIC,
          { ...DROPDOWN, options: Array.from({ length: 21 }, (_, index) => `Track ${index}`) },
        ],
      }),
    );
    await refuses(stored({ criteria: [NUMERIC, { ...DROPDOWN, options: ["Platform", " "] }] }));
    await refuses(
      stored({ criteria: [NUMERIC, { ...DROPDOWN, options: ["Platform", "x".repeat(81)] }] }),
    );
  });

  it("refuses a text criterion whose answer box is absurd", async () => {
    await refuses(stored({ criteria: [NUMERIC, { ...TEXT, maxLength: 0 }] }));
    await refuses(stored({ criteria: [NUMERIC, { ...TEXT, maxLength: 5001 }] }));
    await refuses(stored({ criteria: [NUMERIC, { ...TEXT, maxLength: 12.5 }] }));
  });

  it("takes the payload this slice exports, up to every ceiling it holds", async () => {
    // The other half of the same claim: a reader that refuses a legitimate export has broken the
    // round trip, and an empty half is what a source with no configured statuses produces.
    const { actor, review, templateRepository, templates } = await setup();
    const { template } = await save(templates, actor);
    const version = await templateRepository.findVersion(template.id, 1);
    const criteria = [
      criterion({ minScore: 0, maxScore: 10, weight: 100 }),
      { ...DROPDOWN, description: "" },
      TEXT,
    ];
    (version?.payload.slices as Record<string, unknown>).review = { statuses: [], criteria };

    const result = await applyTo(templates, actor, template.id);

    expect(reviewSlice(result.slices)?.outcome).toBe("applied");
    const workspace = await review.organizerWorkspace(actor, DESTINATION);
    expect(workspace.plan?.criteria).toEqual(criteria);
    // An empty status list is completed with the reserved decision keys rather than refused,
    // which is what `configureStatuses` does with any submission that omits them.
    expect(workspace.statuses.map(({ key }) => key)).toEqual(["accepted", "declined"]);
  });
});

/*
 * A payload at rest reads the same way on every attempt, so the orchestrator's generic "apply
 * this version again" would be advice that cannot work, and routing it through `onSliceFault`
 * would page an operator for a template that is simply wrong. Raised as `SliceRefusalError`,
 * this slice's own sentence reaches the organizer and the fault sink stays quiet — which is why
 * the type, not just the wording, is what this asserts.
 */
describe("Review template slice: what it refuses in its own words", () => {
  const REMAP = {
    destination: { ...DESTINATION_RANGE, eventId: DESTINATION, timezone: "UTC" },
    source: { eventId: SOURCE, timezone: "UTC" },
  };
  const unreached = (): never => {
    throw new Error("The payload should never have reached the destination");
  };
  const slice = reviewTemplateSlice({
    configurePlan: unreached,
    configureStatuses: unreached,
    reviewConfiguration: unreached,
  });

  it("refuses a stored status set it cannot read", async () => {
    // A status with no label and no sort order: not a shape `configureStatuses` would store, and
    // a hand-edited row is exactly where one arrives from.
    const refused = slice.apply(
      organizer([DESTINATION]),
      DESTINATION,
      { statuses: [{ key: "screening" }], criteria: [] },
      REMAP,
    );

    await expect(refused).rejects.toBeInstanceOf(SliceRefusalError);
    await expect(refused).rejects.toThrow(
      "This template's stored review configuration could not be read.",
    );
  });
});
