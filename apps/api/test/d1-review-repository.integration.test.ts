// @acceptance ACC-REVIEW
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1ReviewDatabasePort,
  D1ReviewRepository,
} from "../src/adapters/persistence/d1-review-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { ReviewStateConflictError } from "../src/application/review/review-repository";
import { applyMigrationFile, createMigratedDatabase } from "./support/seeded-d1";

describe("review D1 persistence", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("round-trips seeds and commits audited bulk transitions atomically", async () => {
    const migrated = await createMigratedDatabase({ label: "review", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const proposals = new D1SubmittedProposalAdapter(database as D1ProposalDatabasePort);
    const reviews = new D1ReviewRepository(database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const proposalId = "10000000-0000-4000-8000-000000000002";
    await expect(
      proposals.transitionAtomically({
        eventId,
        proposalIds: [proposalId],
        toStatus: "not_configured",
        actorId: "seed-organizer",
        occurredAt: "2026-08-10T11:59:00.000Z",
        auditIds: ["30000000-0000-4000-8000-000000000000"],
      }),
    ).rejects.toThrow("configured proposal status");
    await expect(
      proposals.transitionAtomically({
        eventId,
        proposalIds: [proposalId],
        toStatus: "under_review",
        actorId: "seed-organizer",
        occurredAt: "2026-08-10T12:00:00.000Z",
        auditIds: ["30000000-0000-4000-8000-000000000001"],
      }),
    ).resolves.toMatchObject([{ status: "under_review" }]);
    await expect(proposals.listAudit(eventId)).resolves.toMatchObject([
      { proposalId, fromStatus: "submitted", toStatus: "under_review" },
    ]);
    await expect(
      proposals.saveStatuses(eventId, [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "reviewed", label: "Reviewed", sortOrder: 1 },
      ]),
    ).rejects.toThrow("currently in use");
    // The seed's accepted proposal carries a real decision record, which is what content
    // acceptance is gated on — `reset.sql` no longer names a proposal id that exists nowhere.
    const seededProposalId = "10000000-0000-4000-8000-000000000010";
    await expect(reviews.findDecision(eventId, seededProposalId)).resolves.toMatchObject({
      outcome: "accepted",
      decidedBy: "seed-organizer",
    });
    // Counted relative to whatever the seed carries rather than against a literal, so the
    // overwrite claim below survives the seed gaining another accepted proposal.
    const seededDecisions = await reviews.listDecisions(eventId);
    expect(seededDecisions.filter(({ proposalId: id }) => id === seededProposalId)).toHaveLength(1);
    // Deciding again overwrites rather than duplicating, so a retry after a partial failure heals.
    await reviews.saveDecision({
      eventId,
      proposalId: seededProposalId,
      outcome: "declined",
      decidedBy: "seed-organizer",
      decidedAt: "2026-08-10T13:00:00.000Z",
      note: "Reversed",
    });
    const afterOverwrite = await reviews.listDecisions(eventId);
    expect(afterOverwrite).toHaveLength(seededDecisions.length);
    expect(afterOverwrite.filter(({ proposalId: id }) => id === seededProposalId)).toMatchObject([
      { outcome: "declined", note: "Reversed" },
    ]);
    // A decision must reference a real submission of that event.
    await expect(
      reviews.saveDecision({
        eventId,
        proposalId: "no-such-proposal",
        outcome: "accepted",
        decidedBy: "seed-organizer",
        decidedAt: "2026-08-10T13:00:00.000Z",
        note: "",
      }),
    ).rejects.toThrow();
    await expect(reviews.getPlan(eventId)).resolves.toMatchObject({
      criteria: expect.arrayContaining([expect.objectContaining({ id: "relevance" })]),
    });
    await expect(reviews.listAssignments(eventId, "seed-reviewer")).resolves.toHaveLength(1);
    await expect(
      reviews.savePlan({
        eventId,
        criteria: [{ id: "changed", name: "Changed", description: "", minScore: 1, maxScore: 5 }],
        updatedAt: "2026-08-10T12:15:00.000Z",
      }),
    ).rejects.toThrow("locked");
    /*
     * Two storage guards stand between this request and a row, and the second one is new.
     * The secondary event has neither a review plan (`0009`) nor a round (`1312`), and SQLite
     * does not promise which `BEFORE INSERT` trigger fires first — so asserting one exact
     * sentence here would be asserting an ordering nothing guarantees. Each guard is therefore
     * driven on its own, against a database where only that one can fire.
     */
    await expect(
      reviews.createAssignments([
        {
          id: "20000000-0000-4000-8000-000000000003",
          eventId: "00000000-0000-4000-8000-000000000002",
          proposalId: "10000000-0000-4000-8000-000000000003",
          reviewerId: "seed-reviewer",
          createdAt: "2026-08-10T12:15:00.000Z",
        },
      ]),
    ).rejects.toThrow(/Review plan is required|That review round does not exist/);
    // With a round in place, the plan guard is the only one left, and it is the one that answers.
    await reviews.createRound({
      eventId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      name: "Round 1",
      opensAt: null,
      closesAt: null,
      state: "open",
      anonymized: true,
      criteria: null,
      poolMode: "event",
      reviewerIds: [],
      createdAt: "2026-08-10T12:15:00.000Z",
      updatedAt: "2026-08-10T12:15:00.000Z",
    });
    await expect(
      reviews.createAssignments([
        {
          id: "20000000-0000-4000-8000-000000000003",
          eventId: "00000000-0000-4000-8000-000000000002",
          proposalId: "10000000-0000-4000-8000-000000000003",
          reviewerId: "seed-reviewer",
          createdAt: "2026-08-10T12:15:00.000Z",
        },
      ]),
    ).rejects.toThrow("required");
    // And in the other direction: a round number nobody configured is refused on an event whose
    // plan is fine, so the two guards are proven to be two rather than one.
    await expect(
      reviews.createAssignments([
        {
          id: "20000000-0000-4000-8000-000000000004",
          eventId,
          proposalId: "10000000-0000-4000-8000-000000000002",
          reviewerId: "seed-reviewer",
          round: 9,
          createdAt: "2026-08-10T12:15:00.000Z",
        },
      ]),
    ).rejects.toThrow("That review round does not exist");
    const completedAt = "2026-08-10T12:30:00.000Z";
    const evaluation = {
      assignmentId: "20000000-0000-4000-8000-000000000001",
      reviewerId: "seed-reviewer",
      scores: [
        { criterionId: "relevance", score: 4 },
        { criterionId: "clarity", score: 5 },
      ],
      notes: "Strong proposal",
      state: "completed" as const,
      updatedAt: completedAt,
      completedAt,
    };
    const completionEvent = {
      type: "EVT-REVIEW-COMPLETED" as const,
      version: 1 as const,
      id: "40000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId,
      proposalId: "10000000-0000-4000-8000-000000000001",
      assignmentId: evaluation.assignmentId,
      reviewerId: evaluation.reviewerId,
      occurredAt: completedAt,
      correlationId: "persistence-correlation",
      causationId: evaluation.assignmentId,
    };
    await reviews.completeEvaluation(evaluation, completionEvent);
    await reviews.completeEvaluation(evaluation, {
      ...completionEvent,
      id: "40000000-0000-4000-8000-000000000002",
      correlationId: "retry-correlation",
    });
    const outcomesFor = async (proposalId: string) =>
      (await reviews.listOutcomes(eventId)).filter((outcome) => outcome.proposalId === proposalId);
    expect(await outcomesFor(completionEvent.proposalId)).toMatchObject([
      { round: 1, completedEvaluationCount: 1, averageScore: 4 },
    ]);
    const roundTwoAssignment = {
      id: "20000000-0000-4000-8000-000000000012",
      eventId,
      proposalId: completionEvent.proposalId,
      reviewerId: "seed-reviewer",
      round: 2,
      createdAt: "2026-08-10T13:00:00.000Z",
    };
    /*
     * Round 2 is a `named` round whose pool is the other reviewer, so this one is refused until
     * somebody adds them — the acceptance criterion "a reviewer in round 1 is absent from round 2
     * until explicitly added", driven against real D1 rather than against the service's own
     * check. The refusal comes from `review_assignment_requires_pool_membership` (`1312`), which
     * is what makes the pool a property of the schema instead of a rule in a service.
     */
    await expect(reviews.createAssignments([roundTwoAssignment])).rejects.toThrow(
      "not in this round's pool",
    );
    const roundTwo = await reviews.findRound(eventId, 2);
    expect(roundTwo).toMatchObject({ poolMode: "named", state: "open" });
    expect(roundTwo?.reviewerIds).not.toContain("seed-reviewer");
    await reviews.setRoundMembers(
      eventId,
      2,
      [...(roundTwo?.reviewerIds ?? []), "seed-reviewer"],
      "2026-08-10T13:00:00.000Z",
    );
    await expect(reviews.createAssignments([roundTwoAssignment])).resolves.toMatchObject([
      { reviewerId: "seed-reviewer", round: 2 },
    ]);
    /*
     * Scored against **round 2's own scorecard**, not the event plan.
     *
     * The seeded second round carries its own rubric, so `programme_fit` is what the aggregate
     * for this round weighs and `relevance` is a criterion it has never heard of. Scoring the
     * latter here is not merely wrong-looking — it produces no outcome row at all, because the
     * aggregate joins the round's criteria and finds nothing to join. That is the behaviour this
     * line exists to pin: `(2 × 3) / 3 = 2`, under a weight of 3 that only round 2 defines.
     */
    await reviews.completeEvaluation(
      {
        ...evaluation,
        assignmentId: roundTwoAssignment.id,
        scores: [{ criterionId: "programme_fit", value: 2 }],
      },
      {
        ...completionEvent,
        id: "40000000-0000-4000-8000-000000000012",
        assignmentId: roundTwoAssignment.id,
        occurredAt: "2026-08-10T13:30:00.000Z",
        causationId: roundTwoAssignment.id,
      },
    );
    expect(await outcomesFor(completionEvent.proposalId)).toMatchObject([
      { round: 2, completedEvaluationCount: 1, averageScore: 2 },
      { round: 1, completedEvaluationCount: 1, averageScore: 4 },
    ]);
    await expect(
      reviews.getEvaluation(evaluation.assignmentId, evaluation.reviewerId),
    ).resolves.toMatchObject({
      scores: expect.arrayContaining([expect.objectContaining({ score: 4 })]),
    });
    const events = await database
      .prepare("SELECT id FROM review_events WHERE assignment_id = ?")
      .bind(evaluation.assignmentId)
      .all();
    expect(events.results).toHaveLength(1);
    await expect(
      reviews.saveConflict({
        assignmentId: evaluation.assignmentId,
        reviewerId: evaluation.reviewerId,
        reason: "Late conflict",
        declaredAt: completedAt,
      }),
    ).rejects.toThrow("completed");
    const conflictedAssignment = {
      id: "20000000-0000-4000-8000-000000000002",
      eventId,
      proposalId,
      reviewerId: "seed-reviewer",
      createdAt: completedAt,
    };
    await reviews.createAssignments([conflictedAssignment]);
    await reviews.saveConflict({
      assignmentId: conflictedAssignment.id,
      reviewerId: conflictedAssignment.reviewerId,
      reason: "Existing conflict",
      declaredAt: completedAt,
    });
    await expect(
      reviews.completeEvaluation(
        { ...evaluation, assignmentId: conflictedAssignment.id },
        {
          ...completionEvent,
          id: "40000000-0000-4000-8000-000000000003",
          assignmentId: conflictedAssignment.id,
          proposalId,
        },
      ),
    ).rejects.toThrow("conflicted");

    /*
     * Removing an assignment, against the real triggers and the real foreign keys.
     *
     * An organizer's undo for a mis-assignment. The SQL is guarded rather than
     * checked-then-run, so this is the only place the guards are exercised by SQLite itself
     * rather than by a map in memory.
     */
    // Every statement is scoped to an assignment of the named event, so this event's
    // assignment named under another event's id touches nothing — not the row, and not the
    // conflict hanging off it.
    await reviews.deleteAssignment("00000000-0000-4000-8000-000000000002", conflictedAssignment.id);
    await expect(reviews.findAssignment(eventId, conflictedAssignment.id)).resolves.toMatchObject({
      id: conflictedAssignment.id,
    });
    await expect(
      reviews.getConflict(conflictedAssignment.id, conflictedAssignment.reviewerId),
    ).resolves.toMatchObject({ reason: "Existing conflict" });

    // Nothing has been completed against this one, so it goes — and the conflict row hanging
    // off it goes with it, rather than being orphaned against a key that no longer resolves.
    await reviews.deleteAssignment(eventId, conflictedAssignment.id);
    await expect(reviews.findAssignment(eventId, conflictedAssignment.id)).resolves.toBeNull();
    await expect(
      reviews.getConflict(conflictedAssignment.id, conflictedAssignment.reviewerId),
    ).resolves.toBeNull();
    // The scored one is refused, and nothing about it moves: the evaluation and the aggregate
    // it feeds both survive the attempt.
    await expect(reviews.deleteAssignment(eventId, evaluation.assignmentId)).rejects.toThrow(
      "completed",
    );
    await expect(reviews.findAssignment(eventId, evaluation.assignmentId)).resolves.toMatchObject({
      id: evaluation.assignmentId,
    });
    await expect(
      reviews.getEvaluation(evaluation.assignmentId, evaluation.reviewerId),
    ).resolves.toMatchObject({ state: "completed" });
    expect(await outcomesFor(completionEvent.proposalId)).toMatchObject([
      { round: 2, completedEvaluationCount: 1, averageScore: 2 },
      { round: 1, completedEvaluationCount: 1, averageScore: 4 },
    ]);
    // An id that is not there is not an error: the caller has already been told it is gone.
    await expect(
      reviews.deleteAssignment(eventId, "20000000-0000-4000-8000-0000000000ff"),
    ).resolves.toBeUndefined();
  });
  /*
   * The suggestion port against real D1, where the guarantees actually live.
   *
   * The service tests above run on the in-memory repository, so they prove the *rules*. These
   * prove the rules survive SQLite: the `CHECK` that refuses an unattributed answer, the trigger
   * that refuses a fabricated provenance link, and the batch whose two statements either both land
   * or neither does. Each one is the reason a reviewer's acceptance can be trusted as an act.
   */
  it("stores a suggestion with its provenance and answers it exactly once", async () => {
    const migrated = await createMigratedDatabase({ label: "review-suggestions", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const reviews = new D1ReviewRepository(database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const assignmentId = "20000000-0000-4000-8000-000000000001";
    const proposalId = "10000000-0000-4000-8000-000000000001";
    const suggestionId = "40000000-0000-4000-8000-000000000001";
    const suggestion = {
      id: suggestionId,
      eventId,
      assignmentId,
      reviewerId: "seed-reviewer",
      proposalId,
      round: 1,
      summary: "A talk about watermark-only stream joins.",
      scores: [
        { criterionId: "relevance", value: 4, rationale: "Squarely on topic." },
        { criterionId: "format", value: "Talk", rationale: "Reads as a talk." },
        {
          criterionId: "feedback",
          value: "Ask for a demo.",
          rationale: "The claim needs showing.",
        },
      ],
      state: "offered" as const,
      provenance: {
        model: "fixture-suggester-v1",
        promptVersion: "review-suggestion/v1",
        generatedAt: "2026-08-10T12:00:00.000Z",
        proposalRevision: "rev-deadbeef",
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    };

    const outcomesBefore = await reviews.listOutcomes(eventId);
    await reviews.saveSuggestion(suggestion);

    // Provenance round-trips as four columns, not a blob nobody can query.
    await expect(reviews.findSuggestion(eventId, suggestionId, "seed-reviewer")).resolves.toEqual(
      suggestion,
    );
    // Another reviewer's read is indistinguishable from a suggestion that does not exist.
    await expect(reviews.findSuggestion(eventId, suggestionId, "someone-else")).resolves.toBeNull();
    // The seed offers one suggestion on this assignment already, so the claim is that this one
    // joined it rather than that it is the only one in the database.
    const suggestionsNow = await reviews.listSuggestionsForReviewer(eventId, "seed-reviewer");
    expect(suggestionsNow.filter(({ id }) => id === suggestionId)).toHaveLength(1);

    // Accepting writes the draft and the answer together.
    const evaluation = {
      assignmentId,
      reviewerId: "seed-reviewer",
      scores: [
        { criterionId: "relevance", value: 4, score: 4 },
        { criterionId: "format", value: "Talk" },
        { criterionId: "feedback", value: "Ask for a demo." },
      ],
      notes: "",
      state: "draft" as const,
      updatedAt: "2026-08-10T12:05:00.000Z",
      source: "suggested" as const,
      suggestionId,
    };
    await reviews.acceptSuggestion(
      suggestionId,
      "seed-reviewer",
      "2026-08-10T12:05:00.000Z",
      evaluation,
    );

    await expect(
      reviews.findSuggestion(eventId, suggestionId, "seed-reviewer"),
    ).resolves.toMatchObject({
      state: "accepted",
      respondedBy: "seed-reviewer",
      respondedAt: "2026-08-10T12:05:00.000Z",
    });
    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toMatchObject({
      state: "draft",
      source: "suggested",
      suggestionId,
    });
    // Accepting moved no aggregate: only the reviewer's own completion does that. Asserted
    // against the seeded baseline rather than against an empty table — the seed now holds three
    // real outcomes, and "unchanged" is the claim, not "absent".
    expect(await reviews.listOutcomes(eventId)).toEqual(outcomesBefore);

    // The reviewer then edits their draft. A replayed acceptance must not undo that.
    await reviews.saveEvaluation({
      ...evaluation,
      notes: "My own words",
      updatedAt: "2026-08-10T12:06:00.000Z",
    });
    await expect(
      reviews.acceptSuggestion(
        suggestionId,
        "seed-reviewer",
        "2026-08-10T12:07:00.000Z",
        evaluation,
      ),
    ).rejects.toThrow(ReviewStateConflictError);
    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toMatchObject({
      notes: "My own words",
    });
    // Editing a draft that began as a suggestion does not relabel it as hand-written.
    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toMatchObject({
      source: "suggested",
      suggestionId,
    });
  });

  it("refuses an unattributed answer and a fabricated provenance link", async () => {
    const migrated = await createMigratedDatabase({
      label: "review-suggestion-guards",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    const reviews = new D1ReviewRepository(database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const assignmentId = "20000000-0000-4000-8000-000000000001";
    const suggestionId = "40000000-0000-4000-8000-000000000002";
    await reviews.saveSuggestion({
      id: suggestionId,
      eventId,
      assignmentId,
      reviewerId: "seed-reviewer",
      proposalId: "10000000-0000-4000-8000-000000000001",
      round: 1,
      summary: "Summary",
      scores: [],
      state: "offered",
      provenance: {
        model: "m",
        promptVersion: "v",
        generatedAt: "2026-08-10T12:00:00.000Z",
        proposalRevision: "rev-00000000",
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    // A suggestion can never leave `offered` without a named human behind it. Without this the
    // state column is a string anything could set, and "never becomes a score without a human
    // action" would rest on the service alone.
    await expect(
      database
        .prepare("UPDATE review_suggestions SET state = 'accepted' WHERE id = ?")
        .bind(suggestionId)
        .run(),
    ).rejects.toThrow();

    // An evaluation cannot claim provenance it does not have: the suggestion must exist, and it
    // must belong to this assignment and this reviewer.
    await expect(
      database
        .prepare(
          "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source, suggestion_id) VALUES (?, 'seed-reviewer', '[]', '', 'draft', '2026-08-10T12:00:00.000Z', NULL, 'suggested', NULL)",
        )
        .bind(assignmentId)
        .run(),
    ).rejects.toThrow();
    await expect(
      database
        .prepare(
          "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source, suggestion_id) VALUES (?, 'somebody-else', '[]', '', 'draft', '2026-08-10T12:00:00.000Z', NULL, 'suggested', ?)",
        )
        .bind(assignmentId, suggestionId)
        .run(),
    ).rejects.toThrow();

    // And a hand-written evaluation is unaffected — the default is `manual`, with no null to read.
    await reviews.saveEvaluation({
      assignmentId,
      reviewerId: "seed-reviewer",
      scores: [{ criterionId: "relevance", value: 3, score: 3 }],
      notes: "",
      state: "draft",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });
    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toMatchObject({
      source: "manual",
      suggestionId: null,
    });
  });

  it("rejecting a suggestion writes no evaluation and cannot be replayed", async () => {
    const migrated = await createMigratedDatabase({
      label: "review-suggestion-reject",
      seed: true,
    });
    runtime = migrated.runtime;
    const reviews = new D1ReviewRepository(migrated.database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const assignmentId = "20000000-0000-4000-8000-000000000001";
    const suggestionId = "40000000-0000-4000-8000-000000000003";
    const outcomesBefore = await reviews.listOutcomes(eventId);
    await reviews.saveSuggestion({
      id: suggestionId,
      eventId,
      assignmentId,
      reviewerId: "seed-reviewer",
      proposalId: "10000000-0000-4000-8000-000000000001",
      round: 1,
      summary: "Summary",
      scores: [],
      state: "offered",
      provenance: {
        model: "m",
        promptVersion: "v",
        generatedAt: "2026-08-10T12:00:00.000Z",
        proposalRevision: "rev-00000000",
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    await reviews.rejectSuggestion(suggestionId, "seed-reviewer", "2026-08-10T12:05:00.000Z");

    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toBeNull();
    // Unchanged rather than empty: the seed holds three real outcomes and a rejection moves none
    // of them, which is the claim.
    expect(await reviews.listOutcomes(eventId)).toEqual(outcomesBefore);
    // The row survives as the audit record of what was offered and declined.
    await expect(
      reviews.findSuggestion(eventId, suggestionId, "seed-reviewer"),
    ).resolves.toMatchObject({ state: "rejected", respondedBy: "seed-reviewer" });
    await expect(
      reviews.rejectSuggestion(suggestionId, "seed-reviewer", "2026-08-10T12:06:00.000Z"),
    ).rejects.toThrow(ReviewStateConflictError);
  });
});

describe("review round rebuild correction", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("runs 1301 over seeded assignments with evaluations, conflicts and outcomes", async () => {
    const migrated = await createMigratedDatabase({
      label: "review-rebuild-populated",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    const eventId = "00000000-0000-4000-8000-000000000001";
    const reviewerId = "seed-reviewer";
    const evaluatedAssignment = "20000000-0000-4000-8000-000000000001";
    const conflictedAssignment = "rebuild-conflicted-assignment";

    await database
      .prepare(
        "INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .bind(
        conflictedAssignment,
        eventId,
        "10000000-0000-4000-8000-000000000002",
        reviewerId,
        "2026-08-12T12:00:00.000Z",
      )
      .run();
    await database
      .prepare(
        "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at) VALUES (?, ?, '[]', 'seeded rebuild', 'completed', ?, ?)",
      )
      .bind(evaluatedAssignment, reviewerId, "2026-08-12T12:01:00.000Z", "2026-08-12T12:01:00.000Z")
      .run();
    await database
      .prepare(
        "INSERT INTO review_conflicts (assignment_id, reviewer_id, reason, declared_at) VALUES (?, ?, 'seeded rebuild', ?)",
      )
      .bind(conflictedAssignment, reviewerId, "2026-08-12T12:02:00.000Z")
      .run();
    await database
      .prepare(
        "INSERT INTO review_outcomes (event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at) VALUES (?, ?, 1, 1, 4.5, ?)",
      )
      .bind(eventId, "10000000-0000-4000-8000-000000000001", "2026-08-12T12:03:00.000Z")
      .run();

    const counts = async () =>
      (
        await database
          .prepare(
            "SELECT (SELECT COUNT(*) FROM review_assignments) AS assignments, (SELECT COUNT(*) FROM review_evaluations) AS evaluations, (SELECT COUNT(*) FROM review_conflicts) AS conflicts, (SELECT COUNT(*) FROM review_outcomes) AS outcomes",
          )
          .all<{
            assignments: number;
            evaluations: number;
            conflicts: number;
            outcomes: number;
          }>()
      ).results?.[0];
    /*
     * `1301` predates `review_suggestions`, and that is a fact about the replay rather than a
     * bug in either file.
     *
     * `1310` added `review_suggestions.assignment_id`, making that table a **fourth** child of
     * `review_assignments` — one this migration's copy-and-drop recipe knows nothing about,
     * because no suggestion could exist when it ran. Replaying it over a modern seed that holds
     * one fails at `DROP TABLE review_assignments` with a bare foreign key error.
     *
     * So the seeded suggestions are removed first, restoring the shape `1301` actually met. The
     * observation is left here because it is what the next person to rebuild this table needs:
     * the chain is now assignments → conflicts, evaluations and suggestions, with evaluations
     * citing suggestions in turn. `1310`'s own header says so; this is the test that shows it.
     */
    await database.prepare("DELETE FROM review_suggestions").run();

    const before = await counts();
    /*
     * The point of this test is that the rebuild runs over *populated* tables, so the fixture is
     * asserted to be populated rather than trusted to be. Lower bounds rather than exact counts:
     * the seed grew a multi-round review history when rounds became first-class (`1312`), and an
     * exact expectation here would turn every future seed change into a failure of this test
     * while proving nothing extra — what matters is that all four tables have rows before the
     * DROP, which is the arrangement that would have caught `1300`.
     */
    expect(before?.assignments).toBeGreaterThanOrEqual(2);
    expect(before?.evaluations).toBeGreaterThanOrEqual(1);
    expect(before?.conflicts).toBeGreaterThanOrEqual(1);
    expect(before?.outcomes).toBeGreaterThanOrEqual(1);

    await applyMigrationFile(database, "1301_review_rounds_safe_rebuild.sql");

    expect(await counts()).toEqual(before);
    const foreignKeyViolations = await database.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeyViolations.results ?? []).toEqual([]);
    const triggers = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'review_%' ORDER BY name",
      )
      .all<{ name: string }>();
    const names = (triggers.results ?? []).map(({ name }: { name: string }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "review_assignment_cap",
        "review_assignment_requires_plan",
        "review_completion_rejects_conflict",
        "review_conflict_rejects_completion",
        "review_plan_lock",
      ]),
    );
    /*
     * And the hazard the next rebuild has to know about, asserted rather than described.
     *
     * SQLite drops a table's triggers with the table, so this replay of `1301` — which restates
     * only the five triggers that existed when it was written — leaves the three round guards
     * `1312` added **gone**. On a real deployment that never happens, because migrations run once
     * and in order: `1301` ran long before `1312` existed. It matters for the *next* rebuild of
     * `review_assignments`, which will drop these three and must restate them or the round, open
     * -round and pool rules quietly stop being schema rules while every service check still
     * passes. This is the line that turns "remember to restate them" into a failing test.
     */
    expect(names).not.toContain("review_assignment_requires_round");
    expect(names).not.toContain("review_assignment_requires_open_round");
    expect(names).not.toContain("review_assignment_requires_pool_membership");
    // The round tables themselves are untouched by a rebuild of `review_assignments`, which is
    // the whole reason `1312` keyed a round on the number the history already carried.
    const rounds = await database
      .prepare("SELECT COUNT(*) AS total FROM review_rounds")
      .all<{ total: number }>();
    expect(rounds.results?.[0]?.total).toBeGreaterThan(0);
  });
  /**
   * The three defects automated review found in this lane, each against real D1.
   *
   * All three are cases where the in-memory repository was happy and SQLite was not, or where a
   * guard read as if it were unique and was not. They are grouped because they share a fixture.
   */
});

describe("review suggestion races and provenance guards", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("survives unassignment after a suggestion was drafted, and refuses a same-millisecond replay", async () => {
    const migrated = await createMigratedDatabase({ label: "review-suggestion-races", seed: true });
    runtime = migrated.runtime;
    const reviews = new D1ReviewRepository(migrated.database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const assignmentId = "20000000-0000-4000-8000-000000000001";
    const suggestionId = "40000000-0000-4000-8000-000000000010";
    const draft = (id: string) => ({
      id,
      eventId,
      assignmentId,
      reviewerId: "seed-reviewer",
      proposalId: "10000000-0000-4000-8000-000000000001",
      round: 1,
      summary: "Summary",
      scores: [{ criterionId: "relevance", value: 4, rationale: "On topic." }],
      state: "offered" as const,
      provenance: {
        model: "m",
        promptVersion: "v",
        generatedAt: "2026-08-10T12:00:00.000Z",
        proposalRevision: "rev-00000000",
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    const evaluation = {
      assignmentId,
      reviewerId: "seed-reviewer",
      scores: [{ criterionId: "relevance", value: 4, score: 4 }],
      notes: "",
      state: "draft" as const,
      updatedAt: "2026-08-10T12:05:00.000Z",
      source: "suggested" as const,
      suggestionId,
    };

    await reviews.saveSuggestion(draft(suggestionId));
    await reviews.acceptSuggestion(
      suggestionId,
      "seed-reviewer",
      "2026-08-10T12:05:00.000Z",
      evaluation,
    );

    // A replay carrying the *same* timestamp — two accepts inside one millisecond. The first
    // guard keyed on `responded_at`, which is not unique at that resolution, so the loser matched
    // the winner's row and overwrote the reviewer's edited draft before reporting a conflict.
    await reviews.saveEvaluation({
      ...evaluation,
      notes: "My own words",
      updatedAt: "2026-08-10T12:06:00.000Z",
    });
    await expect(
      reviews.acceptSuggestion(
        suggestionId,
        "seed-reviewer",
        "2026-08-10T12:05:00.000Z",
        evaluation,
      ),
    ).rejects.toThrow(ReviewStateConflictError);
    await expect(reviews.getEvaluation(assignmentId, "seed-reviewer")).resolves.toMatchObject({
      notes: "My own words",
    });

    // And unassignment still works once a suggestion exists. `review_suggestions` references the
    // assignment, so leaving it behind made the final DELETE a foreign-key failure — a 500 on the
    // organizer's Unassign control, reachable the moment any reviewer had drafted.
    await reviews.deleteAssignment(eventId, assignmentId);
    await expect(reviews.findAssignment(eventId, assignmentId)).resolves.toBeNull();
    await expect(reviews.listSuggestionsForReviewer(eventId, "seed-reviewer")).resolves.toEqual([]);
  });

  it("refuses an evaluation citing a suggestion nobody accepted, and an impossible source", async () => {
    const migrated = await createMigratedDatabase({
      label: "review-suggestion-source",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    const reviews = new D1ReviewRepository(database as D1ReviewDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const assignmentId = "20000000-0000-4000-8000-000000000001";
    const suggestionId = "40000000-0000-4000-8000-000000000011";
    await reviews.saveSuggestion({
      id: suggestionId,
      eventId,
      assignmentId,
      reviewerId: "seed-reviewer",
      proposalId: "10000000-0000-4000-8000-000000000001",
      round: 1,
      summary: "Summary",
      scores: [],
      state: "offered",
      provenance: {
        model: "m",
        promptVersion: "v",
        generatedAt: "2026-08-10T12:00:00.000Z",
        proposalRevision: "rev-00000000",
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    const insertEvaluation = (source: string, citedId: string | null) =>
      database
        .prepare(
          "INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source, suggestion_id) VALUES (?, 'seed-reviewer', '[]', '', 'draft', '2026-08-10T12:00:00.000Z', NULL, ?, ?)",
        )
        .bind(assignmentId, source, citedId)
        .run();

    // The suggestion exists and belongs to this reviewer, but is still `offered`. Citing it is a
    // claim that an acceptance happened, and no acceptance happened.
    await expect(insertEvaluation("suggested", suggestionId)).rejects.toThrow();
    // A source outside the two the contract allows would reach the transport as an impossible
    // shape, because the adapter casts the column to `EvaluationSource`.
    await expect(insertEvaluation("banana", null)).rejects.toThrow();
    // A hand-written evaluation citing a suggestion is provenance nobody claimed.
    await expect(insertEvaluation("manual", suggestionId)).rejects.toThrow();
    // The honest write still lands.
    await expect(insertEvaluation("manual", null)).resolves.toMatchObject({ success: true });
  });
});

describe("decision revisions", () => {
  const EVENT = "00000000-0000-4000-8000-000000000001";
  const PROPOSAL = "10000000-0000-4000-8000-000000000001";

  const pending = (outcome: "accepted" | "declined", decidedAt: string) => ({
    eventId: EVENT,
    proposalId: PROPOSAL,
    outcome,
    decidedBy: "seed-organizer",
    decidedAt,
    note: "",
  });

  it("holds the revision on a retry and advances it on a reinstatement", async () => {
    /*
     * Against real D1 because the rule lives in the upsert, not in the service: the increment is
     * a `CASE` inside `ON CONFLICT DO UPDATE`, and `RETURNING` is what hands the allocated value
     * back without a second read another writer could interleave with. The in-memory twin
     * implements the same rule; this is what proves the twin is telling the truth.
     */
    const harness = await createMigratedDatabase({ seed: true, label: "review-revision" });
    const repository = new D1ReviewRepository(harness.database as never);

    const first = await repository.saveDecision(pending("accepted", "2026-08-12T09:00:00.000Z"));
    // Same outcome, later instant: the retry `decide` documents as how a decision heals.
    const retry = await repository.saveDecision(pending("accepted", "2026-08-12T10:00:00.000Z"));
    const reversed = await repository.saveDecision(pending("declined", "2026-08-12T11:00:00.000Z"));
    const reinstated = await repository.saveDecision(
      pending("accepted", "2026-08-12T12:00:00.000Z"),
    );

    expect([first, retry, reversed, reinstated]).toEqual([1, 1, 2, 3]);
    // One row throughout — the revision counts decisions, it does not accumulate them.
    const stored = await repository.findDecision(EVENT, PROPOSAL);
    expect(stored).toMatchObject({ outcome: "accepted", revision: 3 });
    expect(
      (await repository.listDecisions(EVENT)).filter(({ proposalId }) => proposalId === PROPOSAL),
    ).toHaveLength(1);
    await harness.dispose();
  });

  it("starts a row that predates the column at one decision, not at zero", async () => {
    // Migration 1311 defaults existing rows to 1, which is the count of decisions they represent.
    const harness = await createMigratedDatabase({ seed: true, label: "review-revision-default" });
    const repository = new D1ReviewRepository(harness.database as never);
    await harness.database
      .prepare(
        "INSERT INTO review_decisions (event_id, proposal_id, outcome, decided_by, decided_at, note) VALUES (?, ?, 'accepted', 'seed-organizer', '2026-08-01T00:00:00.000Z', '')",
      )
      .bind(EVENT, PROPOSAL)
      .run();

    expect(await repository.findDecision(EVENT, PROPOSAL)).toMatchObject({ revision: 1 });
    // …and the next genuine decision advances from it rather than restarting.
    expect(await repository.saveDecision(pending("declined", "2026-08-12T09:00:00.000Z"))).toBe(2);
    await harness.dispose();
  });
});
