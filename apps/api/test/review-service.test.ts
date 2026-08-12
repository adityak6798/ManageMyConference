// @acceptance ACC-REVIEW
import { describe, expect, it } from "vitest";
import { D1SubmittedProposalAdapter } from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireEventCapability,
} from "../src/application/identity/actor";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import { ProposalNotAcceptedError, ProposalNotFoundError } from "../src/application/review/public";
import {
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewService,
  ReviewValidationError,
} from "../src/application/review/review-service";

/** The rejection itself, so a test can assert on the typed error's own fields. */
const refusalOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const build = (options: { reviewers?: readonly { id: string; name: string }[] } = {}) => {
  // The people identity-access reports as reviewers of this event. The seeded organizer holds
  // the reviewer role on the demo event too, which is exactly how she came to be offered as an
  // assignable reviewer of her own event.
  const reviewers = options.reviewers ?? [{ id: "seed-reviewer", name: "Ravi Reviewer" }];
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
      answers: [
        { fieldId: "format", label: "Session format", type: "select", value: "Workshop" },
        {
          fieldId: "coauthors",
          label: "Co-authors",
          type: "long_text",
          value: '[{"name":"Avery Chen","role":"Co-presenter"}]',
        },
      ],
      status: "submitted",
    },
  ]);
  const service = new ReviewService({
    repository,
    proposals,
    identities: {
      isReviewerForEvent: async (userId, scopedEventId) =>
        scopedEventId === eventId && reviewers.some(({ id: reviewerId }) => reviewerId === userId),
      listReviewersForEvent: async (scopedEventId) => (scopedEventId === eventId ? reviewers : []),
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
    const [assignment] = await service.distribute(
      organizer,
      eventId,
      [proposalId],
      [reviewer.id],
      1,
    );
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

  it("hides a person's name from reviewers without hiding a field that merely says 'name'", async () => {
    // The projection the reviewer queue reads is built by the D1 adapter, so it is exercised
    // here against a stubbed database rather than through the memory adapter's canned rows.
    const answers = {
      title: "Designing the calm conference",
      name: "The Calm Conference",
      speaker_name: "Alex Morgan",
      email: "alex.morgan@example.test",
    };
    const fields = [
      { id: "title", type: "short_text", label: "Proposal title" },
      // Ambiguous id, unambiguous label: this is the session's name, not a person's.
      { id: "name", type: "short_text", label: "Session name" },
      { id: "speaker_name", type: "short_text", label: "Who is presenting" },
      { id: "email", type: "email", label: "Contact email" },
    ];
    const row = {
      id: proposalId,
      event_id: eventId,
      answers_json: JSON.stringify(answers),
      form_fields_json: JSON.stringify(fields),
      status: "submitted",
    };
    const statement = {
      bind: () => statement,
      run: async () => ({ success: true }),
      all: async <T>() => ({ success: true, results: [row as T] }),
    };
    const adapter = new D1SubmittedProposalAdapter({
      prepare: () => statement,
      batch: async () => [{ success: true }],
    });

    const projected = await adapter.find(eventId, proposalId);
    // The id rule used to short-circuit ahead of the anchored label pattern, so "Session name"
    // was withheld from reviewers as if it were the applicant's name.
    expect(projected?.answers.map(({ fieldId }) => fieldId)).toEqual(["title", "name"]);
    expect(projected?.answers.find(({ fieldId }) => fieldId === "name")?.value).toBe(
      "The Calm Conference",
    );
    // The field that really does name a person is still withheld and still identifies the
    // submitter for organizers.
    expect(projected?.submitter).toEqual({
      name: "Alex Morgan",
      email: "alex.morgan@example.test",
    });
    expect(JSON.stringify(projected?.answers)).not.toContain("Alex Morgan");
  });

  it("keeps a person-name field masked when its label describes the name in prose", async () => {
    // Organizers write labels, not identifiers. A label rule that vetoes an unambiguous
    // person-name id put the applicant's name straight into the reviewer's answer list and
    // left the organizer's submitter name as the raw email address.
    const cases = [
      { id: "speaker_name", label: "Speaker's name" },
      { id: "full_name", label: "Your full name" },
      { id: "submitter_name", label: "Name of the submitting author" },
      { id: "name", label: "Presenter name" },
    ];
    for (const { id, label } of cases) {
      const row = {
        id: proposalId,
        event_id: eventId,
        answers_json: JSON.stringify({
          title: "Designing the calm conference",
          [id]: "Alex Morgan",
          email: "alex.morgan@example.test",
        }),
        form_fields_json: JSON.stringify([
          { id: "title", type: "short_text", label: "Proposal title" },
          { id, type: "short_text", label },
          { id: "email", type: "email", label: "Contact email" },
        ]),
        status: "submitted",
      };
      const statement = {
        bind: () => statement,
        run: async () => ({ success: true }),
        all: async <T>() => ({ success: true, results: [row as T] }),
      };
      const projected = await new D1SubmittedProposalAdapter({
        prepare: () => statement,
        batch: async () => [{ success: true }],
      }).find(eventId, proposalId);

      expect(JSON.stringify(projected?.answers), `${id} / ${label}`).not.toContain("Alex Morgan");
      expect(projected?.submitter?.name, `${id} / ${label}`).toBe("Alex Morgan");
    }
  });

  it("persists the reserved decision statuses it advertises rather than projecting them", async () => {
    const { service, proposals } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    // The CFP insert trigger seeds only `submitted` for a newly created event.
    await proposals.saveStatuses(eventId, [{ key: "submitted", label: "Submitted", sortOrder: 0 }]);

    const advertised = (await service.organizerWorkspace(organizer, eventId)).statuses.map(
      ({ key }) => key,
    );
    expect(advertised).toEqual(["submitted", "accepted", "declined"]);
    // Storage is the single source of truth: reading the workspace stored what it advertised.
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toEqual(advertised);
    // Every status the workspace offers is reachable — but not all of them by the same route.
    // A pipeline step is a transition; the two reserved outcomes are a decision, which is what
    // records who decided. Reaching any of them used to answer 400, which is what this pins.
    for (const toStatus of advertised.filter((key) => key === "submitted"))
      await expect(
        service.bulkTransition(organizer, eventId, [proposalId], toStatus),
      ).resolves.toMatchObject([{ status: toStatus }]);
    for (const outcome of ["accepted", "declined"] as const)
      await expect(
        service.decide(organizer, eventId, [proposalId], outcome),
      ).resolves.toMatchObject({ proposals: [{ status: outcome }] });
    // Deciding still heals storage for an event that never went through the workspace.
    await proposals.saveStatuses(eventId, [{ key: "declined", label: "Declined", sortOrder: 0 }]);
    await expect(
      service.decide(organizer, eventId, [proposalId], "accepted"),
    ).resolves.toMatchObject({ proposals: [{ status: "accepted" }] });
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toContain("accepted");
  });

  it("completes a status set that leaves the reserved decision statuses out, rather than refusing it", async () => {
    const { service, proposals } = build();
    const organizer = await resolveSeededDemoActor("organizer");

    // The pipeline an organizer actually configures says nothing about decisions.
    const saved = await service.configureStatuses(organizer, eventId, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "under_review", label: "Under review", sortOrder: 1 },
    ]);
    expect(saved.map(({ key }) => key)).toEqual([
      "submitted",
      "under_review",
      "accepted",
      "declined",
    ]);
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toEqual(
      saved.map(({ key }) => key),
    );
    // Relabelling and reordering a reserved status is the organizer's to do; deleting it is not,
    // so their definition survives and the missing one is filled in.
    const relabelled = await service.configureStatuses(organizer, eventId, [
      { key: "accepted", label: "In the programme", sortOrder: 0 },
      { key: "submitted", label: "Submitted", sortOrder: 1 },
    ]);
    expect(relabelled).toEqual([
      { key: "accepted", label: "In the programme", sortOrder: 0 },
      { key: "submitted", label: "Submitted", sortOrder: 1 },
      { key: "declined", label: "Declined", sortOrder: 91 },
    ]);
    // A non-reserved status still in use may not be dropped — that guard is untouched.
    await service.configureStatuses(organizer, eventId, [
      { key: "submitted", label: "Submitted", sortOrder: 0 },
      { key: "under_review", label: "Under review", sortOrder: 1 },
    ]);
    await service.bulkTransition(organizer, eventId, [proposalId], "under_review");
    await expect(
      service.configureStatuses(organizer, eventId, [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
      ]),
    ).rejects.toBeInstanceOf(ReviewValidationError);
    // Duplicate keys are still rejected outright.
    await expect(
      service.configureStatuses(organizer, eventId, [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "submitted", label: "Again", sortOrder: 1 },
      ]),
    ).rejects.toBeInstanceOf(ReviewValidationError);
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
  /*
   * Triage may only offer reviewers who can actually open the queue.
   *
   * The seeded organizer holds the reviewer role on her own event, so "Assign selection to"
   * listed "Olivia Organizer" first. Choosing her succeeded and produced work nobody could
   * ever do: the organizer console has no reviewer queue, there is no unassign, and the click
   * locked the rubric for good. The list no longer offers her, and `assign` refuses the same
   * identity so a request that did not come from the list cannot do it either.
   */
  it("never offers the signed-in organizer as an assignable reviewer of her own event", async () => {
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    const { service } = build({
      reviewers: [
        { id: organizer.id, name: "Olivia Organizer" },
        { id: reviewer.id, name: "Ravi Reviewer" },
      ],
    });
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 },
    ]);

    const workspace = await service.organizerWorkspace(organizer, eventId);
    expect(workspace.proposals[0]?.coAuthors).toEqual([
      { name: "Avery Chen", role: "Co-presenter" },
    ]);
    expect(workspace.reviewers).toEqual([{ id: reviewer.id, name: "Ravi Reviewer" }]);
    /*
     * Withheld from the *assignable* list, still present in the directory.
     *
     * The two are different questions. Triage resolves an existing assignment's name out of
     * what the workspace sends, so answering "who is already assigned?" from the shortened
     * list printed a raw user id in the Reviewers column for every assignment the signed-in
     * organizer could not have made herself — the exact co-organizer case this separates.
     */
    expect(workspace.reviewerDirectory).toEqual([
      { id: organizer.id, name: "Olivia Organizer" },
      { id: reviewer.id, name: "Ravi Reviewer" },
    ]);

    await expect(
      service.assign(organizer, eventId, [proposalId], organizer.id),
    ).rejects.toBeInstanceOf(ReviewValidationError);
    // Nothing was recorded, so the rubric is not locked by a mistake that cannot be undone.
    expect((await service.organizerWorkspace(organizer, eventId)).assignments).toEqual([]);
    await expect(
      service.configurePlan(organizer, eventId, [
        { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 },
      ]),
    ).resolves.toMatchObject({ eventId });

    // Everyone else on the list still works, and they can open what they were given.
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    expect(assignment).toBeDefined();
    expect(await service.reviewerQueue(reviewer, eventId)).toHaveLength(1);
  });

  /*
   * The server-side half of the "Move selection to → Accepted" defect.
   *
   * The triage select stopped offering the two reserved keys, but the route behind it still
   * took them: a transition to `accepted` answered 200 and wrote exactly the half-state the UI
   * fix exists to prevent — the board turns green, the Accepted count rises, and no decision is
   * stored, so no session or speaker exists and the content domain refuses the very abstract the
   * board says is in the programme. A dropdown that no longer lists it is not a rule.
   */
  it("refuses a transition into a reserved decision status and names the route that records one", async () => {
    const { service, repository } = build();
    const organizer = await resolveSeededDemoActor("organizer");

    for (const toStatus of ["accepted", "declined"] as const) {
      const refusal = await refusalOf(
        service.bulkTransition(organizer, eventId, [proposalId], toStatus),
      );
      expect(refusal, toStatus).toBeInstanceOf(ReviewValidationError);
      // The refusal is actionable: it names the route that does record an outcome, rather than
      // leaving the caller to guess that a status they can see is not a status they may set.
      expect((refusal as ReviewValidationError).fields.toStatus?.join(" "), toStatus).toContain(
        `/api/events/${eventId}/review/decisions`,
      );
      // Nothing moved, nothing was audited, and nothing was recorded.
      const workspace = await service.organizerWorkspace(organizer, eventId);
      expect(workspace.proposals, toStatus).toMatchObject([
        { id: proposalId, status: "submitted" },
      ]);
      expect(workspace.audit, toStatus).toEqual([]);
      await expect(repository.findDecision(eventId, proposalId)).resolves.toBeNull();
    }

    // Pipeline steps are untouched — this refuses the two reserved keys, not bulk transitions.
    await expect(
      service.bulkTransition(organizer, eventId, [proposalId], "under_review"),
    ).resolves.toMatchObject([{ status: "under_review" }]);
    // And the route the refusal names does the thing the transition could not.
    await service.decide(organizer, eventId, [proposalId], "accepted");
    await expect(repository.findDecision(eventId, proposalId)).resolves.toMatchObject({
      outcome: "accepted",
      decidedBy: organizer.id,
    });
  });

  /*
   * A mis-assignment has to be undoable.
   *
   * Assigning is one click and it used to be permanent: the abstract stayed with whoever was
   * named, and — because the rubric locks on the existence of *any* assignment — the evaluation
   * criteria froze for the whole event with no way back. This is the undo, and the one state it
   * refuses.
   */
  it("removes an assignment with its unfinished work, releases the rubric lock, and refuses once it has been scored", async () => {
    const { service, repository } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    const criteria = (name: string) => [
      { id: "fit", name, description: "Audience fit", minScore: 1, maxScore: 5 },
    ];
    await service.configurePlan(organizer, eventId, criteria("Fit"));
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    const assignmentId = assignment?.id as string;
    // A half-written score and a declared conflict both describe this assignment.
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignmentId,
      { scores: [{ criterionId: "fit", score: 3 }], notes: "Half written", complete: false },
      "correlation-draft",
    );
    await service.declareConflict(reviewer, eventId, assignmentId, "Prior collaboration");
    // While it exists the rubric cannot be edited at all — that is the second failure.
    await expect(
      service.configurePlan(organizer, eventId, criteria("Renamed")),
    ).rejects.toBeInstanceOf(ReviewValidationError);

    await expect(service.unassign(organizer, eventId, assignmentId)).resolves.toMatchObject({
      id: assignmentId,
      proposalId,
      reviewerId: reviewer.id,
    });

    // Gone from both surfaces, and the unfinished work goes with it rather than being left
    // pointing at an assignment id that no longer resolves.
    expect((await service.organizerWorkspace(organizer, eventId)).assignments).toEqual([]);
    expect(await service.reviewerQueue(reviewer, eventId)).toEqual([]);
    await expect(repository.getEvaluation(assignmentId, reviewer.id)).resolves.toBeNull();
    await expect(repository.getConflict(assignmentId, reviewer.id)).resolves.toBeNull();
    // And the lock that assignment was holding is released.
    await expect(
      service.configurePlan(organizer, eventId, criteria("Renamed")),
    ).resolves.toMatchObject({ eventId });

    // A completed evaluation is not unfinished work: its score is counted in this abstract's
    // aggregate and it has emitted EVT-REVIEW-COMPLETED, so removing the assignment under it
    // would restate a number an organizer has already read.
    const [second] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    const scoredId = second?.id as string;
    await service.saveEvaluation(
      reviewer,
      eventId,
      scoredId,
      { scores: [{ criterionId: "fit", score: 4 }], notes: "", complete: true },
      "correlation-complete",
    );
    const refusal = await refusalOf(service.unassign(organizer, eventId, scoredId));
    expect(refusal).toBeInstanceOf(ReviewValidationError);
    expect((refusal as ReviewValidationError).fields.assignmentId?.join(" ")).toContain(
      "already completed their evaluation",
    );
    // The refusal changed nothing: the assignment, the score and the aggregate all survive.
    expect((await service.organizerWorkspace(organizer, eventId)).assignments).toHaveLength(1);
    await expect(repository.getEvaluation(scoredId, reviewer.id)).resolves.toMatchObject({
      state: "completed",
    });
    expect((await service.organizerWorkspace(organizer, eventId)).outcomes).toMatchObject([
      { proposalId, completedEvaluationCount: 1 },
    ]);
  });

  it("lets only an organizer of this event unassign, and answers the same way for an id it cannot see", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 },
    ]);
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    const assignmentId = assignment?.id as string;

    // The reviewer holding it cannot hand it back — declaring a conflict is their exit, and it
    // leaves the record intact.
    await expect(service.unassign(reviewer, eventId, assignmentId)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    await expect(service.unassign(null, eventId, assignmentId)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    // An id that does not exist and a real id belonging to another event are the same answer,
    // so this cannot be used to probe another event's assignments (`ARC-AUTH-001`).
    await expect(
      service.unassign(organizer, eventId, "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);
    await expect(
      service.unassign(organizer, "00000000-0000-4000-8000-000000000002", assignmentId),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);

    // None of them removed anything.
    expect((await service.organizerWorkspace(organizer, eventId)).assignments).toHaveLength(1);
    expect(await service.reviewerQueue(reviewer, eventId)).toHaveLength(1);
  });

  it("round-trips typed weighted criteria and reports reviewer progress", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    await service.configurePlan(organizer, eventId, [
      {
        id: "impact",
        name: "Impact",
        description: "Audience value",
        type: "numeric",
        minScore: 1,
        maxScore: 5,
        weight: 3,
      },
      {
        id: "confidence",
        name: "Confidence",
        description: "Recommendation",
        type: "numeric",
        minScore: 1,
        maxScore: 5,
        weight: 1,
      },
      {
        id: "format",
        name: "Format",
        description: "Best format",
        type: "dropdown",
        options: ["Talk", "Workshop"],
        weight: 1,
      },
      {
        id: "feedback",
        name: "Feedback",
        description: "Rationale",
        type: "text",
        maxLength: 500,
        weight: 1,
      },
    ]);
    const [assignment] = await service.assign(organizer, eventId, [proposalId], reviewer.id);
    expect((await service.organizerWorkspace(organizer, eventId)).progress).toContainEqual({
      reviewerId: reviewer.id,
      assigned: 1,
      completed: 0,
      outstanding: 1,
    });
    await service.saveEvaluation(
      reviewer,
      eventId,
      assignment?.id as string,
      {
        scores: [
          { criterionId: "impact", value: 4 },
          { criterionId: "confidence", value: 1 },
          { criterionId: "format", value: "Workshop" },
          { criterionId: "feedback", value: "Strong practical detail" },
        ],
        notes: "",
        complete: true,
      },
      "typed-criteria",
    );
    const workspace = await service.organizerWorkspace(organizer, eventId);
    expect(workspace.evaluations?.[0]?.scores).toMatchObject([
      { criterionId: "impact", value: 4 },
      { criterionId: "confidence", value: 1 },
      { criterionId: "format", value: "Workshop" },
      { criterionId: "feedback", value: "Strong practical detail" },
    ]);
    expect(workspace.outcomes[0]?.averageScore).toBe(3.25);
    expect(workspace.progress?.[0]).toMatchObject({ completed: 1, outstanding: 0 });
    await expect(
      service.advanceRound(organizer, eventId, "submitted", [reviewer.id], 1, 1),
    ).resolves.toMatchObject({
      round: 2,
      assignments: [{ proposalId, reviewerId: reviewer.id, round: 2 }],
    });
    // Retrying the same command carries the same observed current round and returns the round it
    // already created instead of silently creating round 3.
    await expect(
      service.advanceRound(organizer, eventId, "submitted", [reviewer.id], 1, 1),
    ).resolves.toMatchObject({
      round: 2,
      assignments: [{ proposalId, reviewerId: reviewer.id, round: 2 }],
    });
    const history = await service.reviewerQueue(reviewer, eventId);
    expect(history.map(({ assignment }) => assignment.round)).toEqual([1, 2]);
    expect(history[0]?.evaluation?.state).toBe("completed");
  });

  it("refuses a rubric that cannot produce an aggregate", async () => {
    const { service } = build();
    const organizer = await resolveSeededDemoActor("organizer");
    await expect(
      service.configurePlan(organizer, eventId, [
        {
          id: "feedback",
          name: "Feedback",
          description: "Rationale",
          type: "text",
          maxLength: 500,
        },
      ]),
    ).rejects.toMatchObject({
      fields: { criteria: ["At least one numeric criterion is required for the aggregate"] },
    });
  });

  it("keeps bulk distribution event-scoped and refuses organizer self-assignment", async () => {
    const organizer = await resolveSeededDemoActor("organizer");
    const { service } = build({
      reviewers: [
        { id: "seed-reviewer", name: "Ravi Reviewer" },
        { id: organizer.id, name: "Olivia Organizer" },
      ],
    });
    await service.configurePlan(organizer, eventId, [
      { id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 },
    ]);
    await expect(
      service.distribute(organizer, eventId, [proposalId], [organizer.id], 1),
    ).rejects.toMatchObject({
      fields: { reviewerIds: ["Distribution cannot assign the organizer to their own event"] },
    });
    await expect(
      service.distribute(
        organizer,
        eventId,
        ["10000000-0000-4000-8000-000000000099"],
        ["seed-reviewer"],
        1,
      ),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);
  });
});
