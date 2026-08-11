// @acceptance ACC-CFP
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1CfpRepository,
  type D1CfpDatabasePort,
} from "../src/adapters/persistence/d1-cfp-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
describe("D1CfpRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("persists published snapshots and returns one durable submission for concurrent retries", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "cfp-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const migration of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
      "0005_cfp_snapshot_status.sql",
      "0006_review_workflow.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    for (const migration of [
      "0007_review_completion_conflict_guard.sql",
      "0008_review_conflict_completion_guard.sql",
      "0009_review_assignment_requires_plan.sql",
      "0010_review_plan_lock.sql",
      "0011_cfp_transition_status_guard.sql",
      "0012_cfp_status_in_use_guard.sql",
      "0013_cfp_submission_default_status.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      expect((await database.prepare(sql).run()).success).toBe(true);
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
    const repository = new D1CfpRepository(database as D1CfpDatabasePort);
    const proposals = new D1SubmittedProposalAdapter(database as D1ProposalDatabasePort);
    const form = {
      eventId: "00000000-0000-4000-8000-000000000001",
      title: "CFP",
      description: "",
      fields: [
        {
          id: "title",
          type: "short_text" as const,
          label: "Title",
          guidance: "",
          required: true,
          options: [],
        },
      ],
      status: "open" as const,
      version: 1,
      publishedAt: "2026-08-10T00:00:00.000Z",
      publishedStatus: "open" as const,
    };
    await repository.saveForm(form);
    await repository.savePublished(form, true);
    await expect(repository.findPublished(form.eventId)).resolves.toEqual(form);
    const proposal = {
      id: "00000000-0000-4000-8000-000000000111",
      eventId: form.eventId,
      cfpVersion: 1,
      idempotencyKey: "same-retry-key",
      answers: { title: "Talk" },
      fields: form.fields,
      submittedAt: "2026-08-10T01:00:00.000Z",
    };
    const [first, second] = await Promise.all([
      repository.createSubmission(proposal),
      repository.createSubmission({ ...proposal, id: "00000000-0000-4000-8000-000000000222" }),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("Expected idempotent submissions");
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(proposal.id);
    const custom = await repository.createSubmission({
      ...proposal,
      id: "10000000-0000-4000-8000-000000000004",
      idempotencyKey: "custom-review-fields",
      answers: {
        level: "Advanced",
        session: "Custom session content",
        contact: "private@example.com",
      },
      fields: [
        {
          id: "level",
          type: "select",
          label: "Experience level",
          guidance: "",
          required: true,
          options: ["Advanced"],
        },
        {
          id: "session",
          type: "long_text",
          label: "Session details",
          guidance: "",
          required: true,
          options: [],
        },
        {
          id: "contact",
          type: "email",
          label: "Contact email",
          guidance: "",
          required: true,
          options: [],
        },
      ],
    });
    expect(custom).not.toBeNull();
    await expect(proposals.find(form.eventId, custom?.id as string)).resolves.toMatchObject({
      title: "Advanced",
      abstract: "Custom session content",
      submitterName: "Applicant",
      answers: [
        { fieldId: "level", label: "Experience level", value: "Advanced" },
        { fieldId: "session", label: "Session details", value: "Custom session content" },
      ],
    });
    await repository.savePublished({ ...form, status: "closed", publishedStatus: "closed" }, true);
    await expect(
      repository.createSubmission({
        ...proposal,
        id: "00000000-0000-4000-8000-000000000333",
        idempotencyKey: "after-close",
      }),
    ).resolves.toBeNull();
  });
});
