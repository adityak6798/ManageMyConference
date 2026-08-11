// @acceptance ACC-CFP
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applySeedData, createMigratedDatabase, statements } from "./support/seeded-d1";
import {
  D1CfpRepository,
  type D1CfpDatabasePort,
} from "../src/adapters/persistence/d1-cfp-repository";
import {
  type ContentDatabasePort,
  D1ContentRepository,
} from "../src/adapters/persistence/d1-content-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { ContentConflictError } from "../src/application/content/content-repository";
describe("D1CfpRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("persists published snapshots and returns one durable submission for concurrent retries", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-published", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
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
    // The email-typed answer never appears in `answers`, and the organizer projection carries
    // it as the submitter instead. A form with no name field identifies its submitter by
    // address rather than inventing one.
    await expect(proposals.find(form.eventId, custom?.id as string)).resolves.toEqual({
      id: custom?.id,
      eventId: form.eventId,
      title: "Advanced",
      abstract: "Custom session content",
      submitterName: "private@example.com",
      submitter: { name: "private@example.com", email: "private@example.com" },
      status: "submitted",
      answers: [
        { fieldId: "level", label: "Experience level", type: "select", value: "Advanced" },
        {
          fieldId: "session",
          label: "Session details",
          type: "long_text",
          value: "Custom session content",
        },
      ],
    });
    // The seeded submissions carry both a name and an email field, so the organizer sees the
    // real person — the `submitterName: "Applicant"` constant is gone.
    await expect(
      proposals.find(form.eventId, "10000000-0000-4000-8000-000000000001"),
    ).resolves.toMatchObject({
      submitterName: "Alex Morgan",
      submitter: { name: "Alex Morgan", email: "alex.morgan@example.test" },
    });
    // And the contact address is never smuggled through the answer list.
    expect(
      JSON.stringify(
        (await proposals.find(form.eventId, "10000000-0000-4000-8000-000000000001"))?.answers,
      ),
    ).not.toContain("alex.morgan@example.test");
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

// The DDL `tools/check-schema-drift.mjs` renders from schema.ts is the declared storage intent
// that `npm run schema:check` proves equal to the migrations. A database built only from that
// DDL has to carry the constraints the repositories silently depend on.
describe("the DDL rendered from schema.ts", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("defaults a submission status and rejects a duplicate proposal acceptance", async () => {
    const declaredDdl = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../../tools/check-schema-drift.mjs", import.meta.url)),
        "--emit-ddl",
      ],
      { encoding: "utf8" },
    );
    // Built from the *declared* DDL, deliberately not from the migrations. This case exists to
    // prove schema.ts carries the constraints the repositories depend on; running it against a
    // migrated database would let a default or a uniqueness constraint disappear from schema.ts
    // while these assertions stayed green — which is precisely what it is here to catch. It is
    // the one fixture in the suite that does not use the shared migration harness, and the
    // reason is this comment.
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: `cfp-declared-ddl-${crypto.randomUUID()}` },
    });
    const database = await runtime.getD1Database("DB");
    for (const statement of statements(declaredDdl)) await database.prepare(statement).run();
    await applySeedData(database);

    const eventId = "00000000-0000-4000-8000-000000000001";
    const repository = new D1CfpRepository(database as D1CfpDatabasePort);
    // createSubmission never names `status`, so the column default is the only thing that keeps
    // this insert off the NOT NULL constraint.
    const submission = await repository.createSubmission({
      id: "10000000-0000-4000-8000-000000000777",
      eventId,
      cfpVersion: 1,
      idempotencyKey: "declared-schema-default-status",
      answers: { title: "Talk" },
      fields: [],
      submittedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(submission?.id).toBe("10000000-0000-4000-8000-000000000777");
    const stored = await database
      .prepare("SELECT status FROM cfp_submissions WHERE id = ?")
      .bind("10000000-0000-4000-8000-000000000777")
      .all<{ status: string }>();
    expect(stored.results?.[0]?.status).toBe("submitted");

    const content = new D1ContentRepository(database as ContentDatabasePort);
    const session = {
      id: "20000000-0000-4000-8000-000000000777",
      eventId,
      proposalId: "declared-schema-proposal",
      title: "Accepted twice",
      abstract: "Concurrent acceptance must collide, not duplicate.",
      format: "45-minute talk",
      speakerProfileIds: ["10000000-0000-4000-8000-000000000777"],
      tags: [],
      tracks: [],
      publicationState: "draft" as const,
    };
    const speaker = {
      id: "10000000-0000-4000-8000-000000000777",
      eventId,
      userId: "seed-speaker",
      sourcePersonId: "declared-schema-person",
      name: "Sam Speaker",
      email: "sam@example.test",
      bio: "",
      pronouns: "they/them",
      organization: "Greenroom Labs",
    };
    await content.accept({ session, speakers: [speaker], tasks: [], messages: [] });
    await expect(
      content.accept({
        session: { ...session, id: "20000000-0000-4000-8000-000000000778" },
        speakers: [
          {
            ...speaker,
            id: "10000000-0000-4000-8000-000000000778",
            sourcePersonId: "declared-schema-person-retry",
          },
        ],
        tasks: [],
        messages: [],
      }),
    ).rejects.toBeInstanceOf(ContentConflictError);
  });
});
