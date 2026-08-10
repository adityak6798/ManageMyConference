// @acceptance ACC-REVIEW
import { describe, expect, it } from "vitest";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import { requireEventCapability } from "../src/application/identity/actor";
import { ReviewConflictError, ReviewService } from "../src/application/review/review-service";

const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const build = () => {
  let id = 0;
  const repository = new MemoryReviewRepository();
  const proposals = new MemorySubmittedProposalAdapter([
    {
      id: proposalId,
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId,
      title: "Test proposal",
      abstract: "Test abstract",
      submitterName: "Applicant",
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
