// @acceptance ACC-REVIEW
import { describe, expect, it } from "vitest";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import { requireEventCapability } from "../src/application/identity/actor";
import {
  ReviewConflictError,
  ReviewService,
  ReviewValidationError,
} from "../src/application/review/review-service";
import { ProposalNotAcceptedError, ProposalNotFoundError } from "../src/application/review/public";

const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const build = () => {
  let id = 0;
  const repository = new MemoryReviewRepository();
  const proposals = new MemorySubmittedProposalAdapter([
    {
      id: proposalId,
      eventId,
      title: "Test proposal",
      abstract: "Test abstract",
      submitterName: "Robin Submitter",
      submitter: { name: "Robin Submitter", email: "robin@example.test" },
      answers: [{ fieldId: "format", label: "Session format", type: "select", value: "Workshop" }],
      status: "submitted",
    },
  ]);
  const service = new ReviewService({
    repository,
    proposals,
    identities: {
      isReviewerForEvent: async (userId, scopedEventId) =>
        userId === "seed-reviewer" && scopedEventId === eventId,
      listReviewersForEvent: async (scopedEventId) =>
        scopedEventId === eventId ? [{ id: "seed-reviewer", name: "Ravi Reviewer" }] : [],
    },
    events: {
      get: async () => ({
        id: eventId,
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Event",
        timezone: "UTC",
        createdAt: "2026-08-09T12:00:00.000Z",
      }),
    },
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { service, repository, proposals };
};

describe("review workflow", () => {
  it("authorizes a capability granted by any role on the event", async () => {
    const organizer = await resolveSeededDemoActor("organizer");
    const actor = {
      ...organizer,
      eventAccess: [
        { eventId, role: "organizer" as const, capabilities: new Set(["review:manage"] as const) },
        { eventId, role: "reviewer" as const, capabilities: new Set(["review:evaluate"] as const) },
      ],
    };
    expect(requireEventCapability(actor, eventId, "review:evaluate")).toBe(actor);
  });
  it("configures, audits, assigns, drafts, completes, and emits an outcome", async () => {
    const { service, repository } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 },
    ]);
    await service.bulkTransition(organizer, eventId, [proposalId], "under_review");
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    expect(assignment).toBeDefined();
    const queue = await service.reviewerQueue(reviewer, eventId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).not.toHaveProperty("outcome");
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment?.id as string,
      { scores: [{ criterionId: "fit", score: 4 }], notes: "Promising", complete: false },
      "correlation-1",
    );
    expect((await service.organizerWorkspace(organizer, eventId)).outcomes).toEqual([]);
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment?.id as string,
      { scores: [{ criterionId: "fit", score: 4 }], notes: "Promising", complete: true },
      "correlation-2",
    );
    expect((await service.organizerWorkspace(organizer, eventId)).outcomes).toMatchObject([
      { proposalId, averageScore: 4, completedEvaluationCount: 1 },
    ]);
    expect(repository.events).toMatchObject([
      { type: "EVT-REVIEW-COMPLETED", version: 1, correlationId: "correlation-2" },
    ]);
    const retried = await service.saveEvaluation(
      reviewer,
      eventId,
      assignment?.id as string,
      { scores: [{ criterionId: "fit", score: 2 }], notes: "Changed retry", complete: true },
      "correlation-retry",
    );
    expect(retried).toMatchObject({ scores: [{ score: 4 }], notes: "Promising" });
    expect(repository.events).toHaveLength(1);
    await expect(
      service.saveEvaluation(
        reviewer,
        eventId,
        assignment?.id as string,
        { scores: [{ criterionId: "fit", score: 4 }], notes: "", complete: false },
        "correlation-draft",
      ),
    ).rejects.toThrow("invalid");
    await expect(
      service.saveEvaluation(
        reviewer,
        eventId,
        assignment?.id as string,
        {
          scores: [
            { criterionId: "fit", score: 2 },
            { criterionId: "fit", score: 3 },
          ],
          notes: "Duplicate criterion",
          complete: false,
        },
        "correlation-duplicate",
      ),
    ).rejects.toThrow("invalid");
    await expect(
      service.declareConflict(reviewer, eventId, assignment?.id as string, "Late conflict"),
    ).rejects.toThrow("invalid");
    await expect(
      service.configurePlan(organizer, eventId, [
        { id: "replacement", name: "Replacement", description: "", minScore: 1, maxScore: 10 },
      ]),
    ).rejects.toThrow("invalid");
    expect((await service.organizerWorkspace(organizer, eventId)).audit).toHaveLength(1);
  });

  it("records an acceptance decision that is what authorizes content, not the status label", async () => {
    const { service, repository } = build();
    const organizer = await resolveSeededDemoActor("organizer");

    // Before a decision the proposal exists but is not acceptable.
    await expect(service.acceptedProposal(eventId, proposalId)).rejects.toBeInstanceOf(
      ProposalNotAcceptedError,
    );
    // An unknown id, and a real id belonging to another event, are the same answer.
    await expect(service.acceptedProposal(eventId, "no-such-proposal")).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    );
    await expect(
      service.acceptedProposal("00000000-0000-4000-8000-000000000002", proposalId),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);

    const decided = await service.decide(organizer, eventId, [proposalId], "accepted", "Great fit");
    expect(decided.proposals).toMatchObject([{ id: proposalId, status: "accepted" }]);
    expect(decided.decisions).toMatchObject([
      { proposalId, outcome: "accepted", decidedBy: "seed-organizer", note: "Great fit" },
    ]);
    // The decision is a stored record, not a derived reading of the status string.
    await expect(repository.findDecision(eventId, proposalId)).resolves.toMatchObject({
      outcome: "accepted",
    });
    await expect(service.acceptedProposal(eventId, proposalId)).resolves.toMatchObject({
      title: "Test proposal",
      abstract: "Test abstract",
      // Read out of the proposal's own answers, not supplied by whoever accepted it.
      format: "Workshop",
      submitter: { name: "Robin Submitter", email: "robin@example.test" },
    });
    expect((await service.organizerWorkspace(organizer, eventId)).decisions).toHaveLength(1);

    // Declining reverses it, and content acceptance stops being authorized again.
    await service.decide(organizer, eventId, [proposalId], "declined");
    await expect(service.acceptedProposal(eventId, proposalId)).rejects.toBeInstanceOf(
      ProposalNotAcceptedError,
    );

    // A decision on a proposal that does not belong to the event is refused outright.
    await expect(
      service.decide(organizer, eventId, ["10000000-0000-4000-8000-000000000009"], "accepted"),
    ).rejects.toThrow("not found");
    // Reviewers cannot decide.
    await expect(
      service.decide(await resolveSeededDemoActor("reviewer"), eventId, [proposalId], "accepted"),
    ).rejects.toThrow();
  });

  it("masks the submitter in the reviewer queue while organizers see the contact", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 },
    ]);
    await service.assign(organizer, eventId, [proposalId], reviewer.id);

    const organizerView = await service.organizerWorkspace(organizer, eventId);
    expect(organizerView.proposals[0]).toMatchObject({
      submitterName: "Robin Submitter",
      submitter: { name: "Robin Submitter", email: "robin@example.test" },
    });

    // Blind review is a real mask at the projection edge, not a constant the adapter happens
    // to emit: the same stored proposal loses its submitter on the way to a reviewer.
    const queue = await service.reviewerQueue(reviewer, eventId);
    expect(queue[0]?.proposal).toMatchObject({ submitterName: "Applicant", submitter: null });
    expect(JSON.stringify(queue)).not.toContain("robin@example.test");
    expect(JSON.stringify(queue)).not.toContain("Robin Submitter");
  });

  it("supplies the reserved decision statuses to an event that never configured them", async () => {
    const { service, proposals } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    // The CFP insert trigger seeds only `submitted` for a newly created event.
    await proposals.saveStatuses(eventId, [{ key: "submitted", label: "Submitted", sortOrder: 0 }]);
    expect(
      (await service.organizerWorkspace(organizer, eventId)).statuses.map(({ key }) => key),
    ).toEqual(["submitted", "accepted", "declined"]);
    // And deciding heals storage rather than failing on an unconfigured status.
    await expect(
      service.decide(organizer, eventId, [proposalId], "accepted"),
    ).resolves.toMatchObject({ proposals: [{ status: "accepted" }] });
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toContain("accepted");
  });

  it("refuses to let an organizer configure the reserved decision statuses away", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    // ERROR-INTENT: the rejection is the assertion subject; it is inspected on the next lines.
    const refused = await service
      .configureStatuses(organizer, eventId, [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
      ])
      .catch((error: ReviewValidationError) => error);
    expect(refused).toBeInstanceOf(ReviewValidationError);
    expect((refused as ReviewValidationError).fields.statuses?.[0]).toContain("accepted, declined");
    await expect(
      service.configureStatuses(organizer, eventId, [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "accepted", label: "In the programme", sortOrder: 1 },
        { key: "declined", label: "Not this year", sortOrder: 2 },
      ]),
    ).resolves.toHaveLength(3);
  });

  it("fails safely for cross-event, unassigned, unauthorized, invalid scores, and conflicts", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    const speaker = await resolveSeededDemoActor("speaker");
    await expect(service.organizerWorkspace(reviewer, eventId)).rejects.toThrow();
    await expect(service.reviewerQueue(speaker, eventId)).rejects.toThrow();
    await expect(service.assign(organizer, eventId, [proposalId], speaker.id)).rejects.toThrow(
      "invalid",
    );
    await expect(
      service.reviewerQueue(reviewer, "00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow();
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 },
    ]);
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    await expect(
      service.saveEvaluation(
        reviewer,
        eventId,
        assignment?.id as string,
        { scores: [{ criterionId: "fit", score: 9 }], notes: "", complete: true },
        "correlation",
      ),
    ).rejects.toThrow("invalid");
    await service.declareConflict(
      reviewer,
      eventId,
      assignment?.id as string,
      "Prior collaboration",
    );
    await expect(
      service.saveEvaluation(
        reviewer,
        eventId,
        assignment?.id as string,
        { scores: [{ criterionId: "fit", score: 3 }], notes: "", complete: false },
        "correlation",
      ),
    ).rejects.toBeInstanceOf(ReviewConflictError);
  });
});
