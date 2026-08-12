// @acceptance ACC-REVIEW
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import {
  type D1ReviewDatabasePort,
  D1ReviewRepository,
} from "../src/adapters/persistence/d1-review-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";

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
});
