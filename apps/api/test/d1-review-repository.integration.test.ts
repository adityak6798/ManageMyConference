// @acceptance ACC-REVIEW
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
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
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "review-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const file of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
      "0005_cfp_snapshot_status.sql",
      "0006_review_workflow.sql",
      "0007_review_completion_conflict_guard.sql",
      "0008_review_conflict_completion_guard.sql",
      "0009_review_assignment_requires_plan.sql",
      "0010_review_plan_lock.sql",
      "0011_cfp_transition_status_guard.sql",
      "0012_cfp_status_in_use_guard.sql",
      "0013_cfp_submission_default_status.sql",
      "0014_content_speaker_portal.sql",
      "0015_crm_conversion.sql",
      "0016_crm_speaker_conversion.sql",
      "0017_agenda.sql",
      "0018_agenda_draft_revision.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      if (/^(000[789]|001[0-3])_/.test(file)) {
        expect((await database.prepare(sql).run()).success).toBe(true);
        continue;
      }
      for (const statement of sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        expect((await database.prepare(statement).run()).success).toBe(true);
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of reset
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      expect((await database.prepare(statement).run()).success).toBe(true);
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
      { completedEvaluationCount: 1, averageScore: 4.5 },
    ]);
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
  });
});
