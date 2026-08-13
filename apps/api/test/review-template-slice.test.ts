// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import type { SubmittedProposal } from "../src/application/cfp/submitted-proposal-interface";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService } from "../src/application/events/public";
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
  submitter: { name: "Robin Submitter", email: "robin@example.test" },
  answers: [],
  status,
});

async function setup(options: { destination?: readonly SubmittedProposal[] } = {}) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  let clock = new Date("2026-08-12T10:00:00.000Z");
  const now = () => clock;

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
    repository: new MemoryEventTemplateRepository(),
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
    // A refusal is the organizer's answer, not a fault: the clone as a whole did not fail.
    expect(result.outcome).toBe("applied");
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
