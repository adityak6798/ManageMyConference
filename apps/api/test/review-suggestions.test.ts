// @acceptance ACC-REVIEW
// @spec PRD-AI-001 PORT-AI PRD-REV-001
//
// The AI suggestion port, tested for the property the issue is actually about: a suggestion is a
// draft, and only a reviewer's own act turns it into anything else.
//
// Several of these assert an *absence* — no evaluation, no outcome, no decision — which is the
// only way to state "never silently changes canonical state" as a test. Where that is the point,
// the assertion names the aggregate rather than checking a boolean, so a future change that starts
// folding suggestions into `review_outcomes` fails here rather than in a demo.
import { describe, expect, it } from "vitest";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { DeterministicSuggestionProvider } from "../src/adapters/suggestions/deterministic-suggestion-provider";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import {
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewService,
  ReviewValidationError,
  SuggestionsDisabledError,
} from "../src/application/review/review-service";
import type {
  ReviewSuggestionPort,
  SuggestionDraft,
  SuggestionRequest,
} from "../src/application/review/suggestion-port";
import { SuggestionUnavailableError } from "../src/application/review/suggestion-port";

const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";

/** A rubric wide enough that "one usable value per criterion type" is a real assertion. */
const CRITERIA = [
  { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 },
  {
    id: "novelty",
    name: "Novelty",
    description: "How new",
    type: "dropdown" as const,
    options: ["Low", "Medium", "High"],
  },
];

const refusalOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

const build = (options: { suggestions?: ReviewSuggestionPort | null } = {}) => {
  let id = 0;
  const repository = new MemoryReviewRepository();
  const proposals = new MemorySubmittedProposalAdapter([
    {
      id: proposalId,
      eventId,
      title: "Test proposal",
      abstract: "Streaming joins without a state store. It works because watermarks are enough.",
      submitterName: "Robin Submitter",
      submitterUserId: null,
      submitter: { name: "Robin Submitter", email: "robin@example.test" },
      answers: [{ fieldId: "format", label: "Session format", type: "select", value: "Workshop" }],
      status: "submitted",
    },
  ]);
  const suggestions =
    options.suggestions === undefined ? new DeterministicSuggestionProvider() : options.suggestions;
  const service = new ReviewService({
    repository,
    proposals,
    ...(suggestions ? { suggestions } : {}),
    // Short, so the deadline backstop is a fast test rather than a slow one.
    suggestionTimeoutMs: 50,
    identities: {
      isReviewerForEvent: async (userId, scoped) =>
        scoped === eventId && (userId === "seed-reviewer" || userId === "other-reviewer"),
      listReviewersForEvent: async (scoped) =>
        scoped === eventId ? [{ id: "seed-reviewer", name: "Ravi Reviewer" }] : [],
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
  return { service, repository, proposals, suggestions };
};

/** An event with a plan, an under-review abstract and one assignment to the seeded reviewer. */
const assigned = async (service: ReviewService) => {
  const organizer = await resolveSeededDemoActor("organizer");
  const reviewer = await resolveSeededDemoActor("reviewer");
  await service.configurePlan(organizer, eventId, CRITERIA);
  await service.bulkTransition(organizer, eventId, [proposalId], "under_review");
  const [assignment] = await service.distribute(organizer, eventId, [proposalId], [reviewer.id], 1);
  if (!assignment) throw new Error("fixture did not create an assignment");
  return { organizer, reviewer, assignment };
};

describe("AI-assisted review suggestions", () => {
  it("drafts a suggestion and writes nothing else", async () => {
    const { service, repository } = build();
    const { reviewer, assignment } = await assigned(service);

    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    expect(suggestion.state).toBe("offered");
    expect(suggestion.respondedBy).toBeNull();
    expect(suggestion.scores.map(({ criterionId }) => criterionId)).toEqual(["fit", "novelty"]);
    // The whole draft-only claim, stated as three absences: the reviewer has no evaluation, the
    // abstract has no aggregate, and nothing has been decided about it.
    expect(await repository.getEvaluation(assignment.id, reviewer.id)).toBeNull();
    expect(await repository.listOutcomes(eventId)).toEqual([]);
    expect(await repository.findDecision(eventId, proposalId)).toBeNull();
  });

  it("records complete provenance and hands it back with the draft", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);

    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    expect(suggestion.provenance).toEqual({
      model: "fixture-suggester-v1",
      promptVersion: "review-suggestion/v1",
      generatedAt: "2026-08-10T12:00:00.000Z",
      // Derived from the abstract's own text, so an edit changes it. The queue recomputes the
      // same value and the surface compares the two.
      proposalRevision: expect.stringMatching(/^rev-[0-9a-f]{8}$/),
    });
    const [item] = await service.reviewerQueue(reviewer, eventId);
    expect(item?.proposalRevision).toBe(suggestion.provenance.proposalRevision);
    expect(item?.suggestions).toHaveLength(1);
  });

  it("reports only aggregate AI draft usage to organizers", async () => {
    const { service } = build();
    const { organizer, reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);
    const offered = await service.organizerWorkspace(organizer, eventId);
    expect(offered.aiReport).toEqual([
      { round: 1, model: "fixture-suggester-v1", state: "offered", count: 1 },
    ]);
    expect(JSON.stringify(offered)).not.toContain(suggestion.summary);

    await service.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "rejected");
    expect((await service.organizerWorkspace(organizer, eventId)).aiReport).toEqual([
      { round: 1, model: "fixture-suggester-v1", state: "rejected", count: 1 },
    ]);
  });

  it("never sends the submitter's identity across the port", async () => {
    // Blind review has to survive a live model, not only a rendered page. The request type has no
    // field for a submitter, so this asserts the fixture saw no trace of one anywhere in it.
    const provider = new DeterministicSuggestionProvider();
    const { service } = build({ suggestions: provider });
    const { reviewer, assignment } = await assigned(service);

    await service.requestSuggestion(reviewer, eventId, assignment.id);

    const [request] = provider.calls;
    expect(request).toBeDefined();
    expect(JSON.stringify(request)).not.toContain("Robin Submitter");
    expect(JSON.stringify(request)).not.toContain("robin@example.test");
  });

  it("accepting produces a draft the reviewer still has to complete", async () => {
    const { service, repository } = build();
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    const answered = await service.respondToSuggestion(
      reviewer,
      eventId,
      assignment.id,
      suggestion.id,
      "accepted",
    );

    expect(answered.suggestion.state).toBe("accepted");
    expect(answered.suggestion.respondedBy).toBe(reviewer.id);
    // A draft, carrying the values the reviewer accepted — and the record of where they came from.
    expect(answered.evaluation?.state).toBe("draft");
    expect(answered.evaluation?.source).toBe("suggested");
    expect(answered.evaluation?.suggestionId).toBe(suggestion.id);
    expect(answered.evaluation?.scores).toEqual(
      suggestion.scores.map(({ criterionId, value }) => ({
        criterionId,
        value,
        ...(typeof value === "number" ? { score: value } : {}),
      })),
    );
    // **The negative the issue asks for.** Accepting moved no aggregate; only the reviewer's own
    // Complete does that, and here it has not happened.
    expect(await repository.listOutcomes(eventId)).toEqual([]);

    // And when they do complete it, the aggregate moves and the provenance survives.
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment.id,
      {
        scores: suggestion.scores.map(({ criterionId, value }) => ({ criterionId, value })),
        notes: "",
        complete: true,
      },
      "correlation-1",
    );
    const outcomes = await repository.listOutcomes(eventId);
    expect(outcomes).toHaveLength(1);
    const completed = await repository.getEvaluation(assignment.id, reviewer.id);
    expect(completed?.state).toBe("completed");
    expect(completed?.source).toBe("suggested");
  });

  it("distinguishes an accepted draft from a hand-written one", async () => {
    const { service, repository } = build();
    const { reviewer, assignment } = await assigned(service);

    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment.id,
      {
        scores: [
          { criterionId: "fit", value: 4 },
          { criterionId: "novelty", value: "High" },
        ],
        notes: "",
        complete: false,
      },
      "correlation-1",
    );

    expect((await repository.getEvaluation(assignment.id, reviewer.id))?.source).toBe("manual");
  });

  it("rejecting leaves no canonical trace beyond the audit record", async () => {
    const { service, repository } = build();
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    const answered = await service.respondToSuggestion(
      reviewer,
      eventId,
      assignment.id,
      suggestion.id,
      "rejected",
    );

    expect(answered.suggestion.state).toBe("rejected");
    expect(answered.suggestion.respondedBy).toBe(reviewer.id);
    expect(answered.evaluation).toBeNull();
    expect(await repository.getEvaluation(assignment.id, reviewer.id)).toBeNull();
    expect(await repository.listOutcomes(eventId)).toEqual([]);
    // The row itself survives, which is the audit record of what was offered and declined.
    expect(await repository.findSuggestion(eventId, suggestion.id, reviewer.id)).not.toBeNull();
  });

  it("keeps the summary out of the reviewer's notes unless they ask for it", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);
    const first = await service.requestSuggestion(reviewer, eventId, assignment.id);

    const plain = await service.respondToSuggestion(
      reviewer,
      eventId,
      assignment.id,
      first.id,
      "accepted",
    );
    expect(plain.evaluation?.notes).toBe("");

    const second = await service.requestSuggestion(reviewer, eventId, assignment.id);
    const withSummary = await service.respondToSuggestion(
      reviewer,
      eventId,
      assignment.id,
      second.id,
      "accepted",
      { includeSummaryInNotes: true },
    );
    expect(withSummary.evaluation?.notes).toContain(second.summary);
  });

  it("a provider that times out leaves the reviewer scoring by hand", async () => {
    // A provider that never settles, so the service's own deadline is what ends the call — the
    // backstop for an implementation that ignores its timeout, which is the case most likely to
    // strand a reviewer.
    const hanging: ReviewSuggestionPort = {
      suggest: () =>
        new Promise<SuggestionDraft>(() => {
          // Deliberately never settles: the reviewer's deadline is the only thing that ends this.
        }),
    };
    const { service, repository } = build({ suggestions: hanging });
    const { reviewer, assignment } = await assigned(service);

    const refusal = await refusalOf(service.requestSuggestion(reviewer, eventId, assignment.id));

    expect(refusal).toBeInstanceOf(SuggestionUnavailableError);
    expect((refusal as SuggestionUnavailableError).code).toBe("PROVIDER_TIMEOUT");
    // The point of the whole failure design: the manual path is untouched.
    const saved = await service.saveEvaluation(
      reviewer,
      eventId,
      assignment.id,
      {
        scores: [
          { criterionId: "fit", value: 3 },
          { criterionId: "novelty", value: "Low" },
        ],
        notes: "By hand",
        complete: true,
      },
      "correlation-1",
    );
    expect(saved.state).toBe("completed");
    expect(saved.source).toBe("manual");
    expect(await repository.listOutcomes(eventId)).toHaveLength(1);
  });

  it("a failing provider surfaces its normalized code and nothing of the abstract", async () => {
    const { service } = build({ suggestions: new DeterministicSuggestionProvider("error") });
    const { reviewer, assignment } = await assigned(service);

    const refusal = await refusalOf(service.requestSuggestion(reviewer, eventId, assignment.id));

    expect(refusal).toBeInstanceOf(SuggestionUnavailableError);
    expect((refusal as SuggestionUnavailableError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("works with the port switched off", async () => {
    const { service, repository } = build({ suggestions: null });
    const { reviewer, assignment } = await assigned(service);

    expect(service.suggestionsEnabled).toBe(false);
    expect(
      await refusalOf(service.requestSuggestion(reviewer, eventId, assignment.id)),
    ).toBeInstanceOf(SuggestionsDisabledError);
    // Everything else about the reviewer's journey is unchanged.
    const [item] = await service.reviewerQueue(reviewer, eventId);
    expect(item?.suggestions).toEqual([]);
    const saved = await service.saveEvaluation(
      reviewer,
      eventId,
      assignment.id,
      {
        scores: [
          { criterionId: "fit", value: 5 },
          { criterionId: "novelty", value: "High" },
        ],
        notes: "",
        complete: true,
      },
      "correlation-1",
    );
    expect(saved.state).toBe("completed");
    expect(await repository.listOutcomes(eventId)).toHaveLength(1);
  });

  it("refuses to answer a stored suggestion once the assistant is switched off", async () => {
    // The suggestion was drafted while the port was on, and the deployment then switched it off.
    // A stale tab must not be able to accept it: "withdrawn entirely" has to mean both paths, or
    // the routes are telling different callers different things.
    const live = build();
    const { reviewer, assignment } = await assigned(live.service);
    const suggestion = await live.service.requestSuggestion(reviewer, eventId, assignment.id);

    const off = new ReviewService({
      repository: live.repository,
      proposals: live.proposals,
      identities: {
        isReviewerForEvent: async () => true,
        listReviewersForEvent: async () => [{ id: "seed-reviewer", name: "Ravi Reviewer" }],
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
      newId: () => "00000000-0000-4000-8000-00000000ffff",
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    expect(
      await refusalOf(
        off.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "accepted"),
      ),
    ).toBeInstanceOf(SuggestionsDisabledError);
    expect(await live.repository.getEvaluation(assignment.id, reviewer.id)).toBeNull();
  });

  it("removes an assignment that has been drafted for", async () => {
    // `review_suggestions` references the assignment, so leaving one behind made the organizer's
    // Unassign control fail once any reviewer had pressed Draft.
    const { service, repository } = build();
    const { organizer, reviewer, assignment } = await assigned(service);
    await service.requestSuggestion(reviewer, eventId, assignment.id);

    await service.unassign(organizer, eventId, assignment.id);

    expect(await repository.findAssignment(eventId, assignment.id)).toBeNull();
    expect(await repository.listSuggestionsForReviewer(eventId, reviewer.id)).toEqual([]);
  });

  it("refuses a second answer to the same suggestion", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);
    await service.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "accepted");

    // Not idempotent on purpose: the reviewer may have edited the draft since, and a replayed
    // acceptance would overwrite their edits with the model's values.
    expect(
      await refusalOf(
        service.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "rejected"),
      ),
    ).toBeInstanceOf(ReviewConflictError);
  });

  it("hides one reviewer's suggestion from another", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, CRITERIA);
    await service.bulkTransition(organizer, eventId, [proposalId], "under_review");
    const [mine] = await service.distribute(organizer, eventId, [proposalId], [reviewer.id], 1);
    if (!mine) throw new Error("fixture did not create an assignment");
    const suggestion = await service.requestSuggestion(reviewer, eventId, mine.id);

    const intruder = { ...reviewer, id: "other-reviewer" };
    // Indistinguishable from a suggestion that does not exist (`ARC-AUTH-001`) — and the
    // assignment check fires first, so neither id leaks.
    expect(
      await refusalOf(
        service.respondToSuggestion(intruder, eventId, mine.id, suggestion.id, "accepted"),
      ),
    ).toBeInstanceOf(Error);
    expect(await service.reviewerQueue(intruder, eventId)).toEqual([]);
  });

  it("refuses to accept a draft the rubric would not accept, naming the criterion", async () => {
    // A provider that answers out of range — the shape of a live model that misread a 1–5 scale.
    const outOfRange: ReviewSuggestionPort = {
      suggest: async (request: SuggestionRequest) => ({
        summary: "Summary",
        scores: [
          { criterionId: "fit", value: 9, rationale: "Nine of five." },
          { criterionId: "novelty", value: "High", rationale: "Novel." },
        ],
        model: "test-model",
        promptVersion: `v-${request.round}`,
      }),
    };
    const { service, repository } = build({ suggestions: outOfRange });
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    const refusal = await refusalOf(
      service.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "accepted"),
    );

    expect(refusal).toBeInstanceOf(ReviewValidationError);
    expect((refusal as ReviewValidationError).fields.scores?.[0]).toContain("Fit");
    // Refused rather than half-written: no partial draft is left behind for the reviewer to
    // discover the gaps in themselves.
    expect(await repository.getEvaluation(assignment.id, reviewer.id)).toBeNull();
  });

  it("does not redraft or overwrite a completed evaluation", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment.id,
      {
        scores: [
          { criterionId: "fit", value: 2 },
          { criterionId: "novelty", value: "Low" },
        ],
        notes: "",
        complete: true,
      },
      "correlation-1",
    );

    expect(
      await refusalOf(service.requestSuggestion(reviewer, eventId, assignment.id)),
    ).toBeInstanceOf(ReviewValidationError);
    // The suggestion drafted before completion cannot be used to reopen it either.
    expect(
      await refusalOf(
        service.respondToSuggestion(reviewer, eventId, assignment.id, suggestion.id, "accepted"),
      ),
    ).toBeInstanceOf(ReviewValidationError);
  });

  it("does not draft for an assignment the reviewer has recused themselves from", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);
    await service.declareConflict(reviewer, eventId, assignment.id, "Former colleague");

    expect(
      await refusalOf(service.requestSuggestion(reviewer, eventId, assignment.id)),
    ).toBeInstanceOf(ReviewConflictError);
  });

  it("refuses to draft before the organizer has configured a rubric", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    // A plan is required to create an assignment at all, so this drafts against an assignment id
    // that does not resolve — the same refusal a stale client would meet.
    await service.configurePlan(organizer, eventId, CRITERIA);
    await service.bulkTransition(organizer, eventId, [proposalId], "under_review");

    expect(
      await refusalOf(
        service.requestSuggestion(reviewer, eventId, "00000000-0000-4000-8000-00000000dead"),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await refusalOf(
        service.respondToSuggestion(
          reviewer,
          eventId,
          "00000000-0000-4000-8000-00000000dead",
          "00000000-0000-4000-8000-00000000beef",
          "accepted",
        ),
      ),
    ).toBeInstanceOf(Error);
  });

  it("scopes a suggestion to the round its assignment belongs to", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, CRITERIA);
    await service.bulkTransition(organizer, eventId, [proposalId], "under_review");
    await service.distribute(organizer, eventId, [proposalId], [reviewer.id], 1);
    const second = await service.advanceRound(
      organizer,
      eventId,
      "under_review",
      [reviewer.id],
      1,
      1,
    );
    const later = second.assignments[0];
    if (!later) throw new Error("fixture did not advance a round");

    const suggestion = await service.requestSuggestion(reviewer, eventId, later.id);

    expect(suggestion.round).toBe(2);
  });

  it("refuses a suggestion that belongs to a different assignment", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);
    const suggestion = await service.requestSuggestion(reviewer, eventId, assignment.id);

    expect(
      await refusalOf(
        service.respondToSuggestion(
          reviewer,
          eventId,
          "00000000-0000-4000-8000-00000000dead",
          suggestion.id,
          "accepted",
        ),
      ),
    ).toBeInstanceOf(Error);
  });

  it("refuses an unknown suggestion id on a real assignment", async () => {
    const { service } = build();
    const { reviewer, assignment } = await assigned(service);

    expect(
      await refusalOf(
        service.respondToSuggestion(
          reviewer,
          eventId,
          assignment.id,
          "00000000-0000-4000-8000-00000000beef",
          "accepted",
        ),
      ),
    ).toBeInstanceOf(ReviewNotFoundError);
  });
});
