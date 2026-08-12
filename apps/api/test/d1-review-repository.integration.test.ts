// @acceptance ACC-REVIEW
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationFile, createMigratedDatabase } from "./support/seeded-d1";
import {
  type D1ReviewDatabasePort,
  D1ReviewRepository,
} from "../src/adapters/persistence/d1-review-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { ReviewStateConflictError } from "../src/application/review/review-repository";

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
    await expect(reviews.listOutcomes(eventId)).resolves.toMatchObject([
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
    await expect(reviews.createAssignments([roundTwoAssignment])).resolves.toMatchObject([
      { reviewerId: "seed-reviewer", round: 2 },
    ]);
    await reviews.completeEvaluation(
      {
        ...evaluation,
        assignmentId: roundTwoAssignment.id,
        scores: [{ criterionId: "relevance", value: 2 }],
      },
      {
        ...completionEvent,
        id: "40000000-0000-4000-8000-000000000012",
        assignmentId: roundTwoAssignment.id,
        occurredAt: "2026-08-10T13:30:00.000Z",
        causationId: roundTwoAssignment.id,
      },
    );
    await expect(reviews.listOutcomes(eventId)).resolves.toMatchObject([
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
    await expect(reviews.listOutcomes(eventId)).resolves.toMatchObject([
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

    await reviews.saveSuggestion(suggestion);

    // Provenance round-trips as four columns, not a blob nobody can query.
    await expect(reviews.findSuggestion(eventId, suggestionId, "seed-reviewer")).resolves.toEqual(
      suggestion,
    );
    // Another reviewer's read is indistinguishable from a suggestion that does not exist.
    await expect(reviews.findSuggestion(eventId, suggestionId, "someone-else")).resolves.toBeNull();
    await expect(
      reviews.listSuggestionsForReviewer(eventId, "seed-reviewer"),
    ).resolves.toHaveLength(1);

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
    // Accepting moved no aggregate: only the reviewer's own completion does that.
    await expect(reviews.listOutcomes(eventId)).resolves.toEqual([]);

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
    await expect(reviews.listOutcomes(eventId)).resolves.toEqual([]);
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
    const before = await counts();
    expect(before).toEqual({ assignments: 2, evaluations: 1, conflicts: 1, outcomes: 1 });

    await applyMigrationFile(database, "1301_review_rounds_safe_rebuild.sql");

    expect(await counts()).toEqual(before);
    const foreignKeyViolations = await database.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeyViolations.results ?? []).toEqual([]);
    const triggers = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'review_%' ORDER BY name",
      )
      .all<{ name: string }>();
    expect((triggers.results ?? []).map(({ name }: { name: string }) => name)).toEqual(
      expect.arrayContaining([
        "review_assignment_cap",
        "review_assignment_requires_plan",
        "review_completion_rejects_conflict",
        "review_conflict_rejects_completion",
        "review_plan_lock",
      ]),
    );
  });
});
