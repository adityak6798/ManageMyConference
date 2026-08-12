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
      routing: [],
      status: "open" as const,
      version: 2,
      publishedAt: "2026-08-10T00:00:00.000Z",
      publishedStatus: "open" as const,
    };
    await expect(repository.saveForm(form, 1)).resolves.toBe(true);
    await repository.savePublished(form, true, form.version);
    await expect(repository.findPublished(form.eventId)).resolves.toEqual(form);
    const competing = await Promise.all([
      repository.saveForm({ ...form, title: "First editor", version: 3 }, 2),
      repository.saveForm({ ...form, title: "Second editor", version: 3 }, 2),
    ]);
    expect(competing.sort()).toEqual([false, true]);
    const winner = await repository.findForm(form.eventId);
    expect(winner?.version).toBe(3);
    expect(["First editor", "Second editor"]).toContain(winner?.title);
    await expect(
      repository.saveForm({ ...form, title: "Stale overwrite", version: 3 }, 2),
    ).resolves.toBe(false);
    expect((await repository.findForm(form.eventId))?.title).toBe(winner?.title);
    await expect(repository.savePublished(form, true, 2)).resolves.toBe(false);
    expect((await repository.findForm(form.eventId))?.title).toBe(winner?.title);
    const routedForm = {
      ...form,
      routing: [
        {
          id: "workshops",
          when: { fieldId: "title", operator: "equals" as const, values: ["Workshop"] },
          routeTo: { status: "workshop_queue" },
        },
      ],
    };
    await database
      .prepare(
        "INSERT INTO cfp_statuses (event_id, key, label, sort_order) VALUES (?, 'workshop_queue', 'Workshop queue', 99)",
      )
      .bind(form.eventId)
      .run();
    await expect(
      repository.saveForm(
        {
          ...routedForm,
          routing: [
            {
              id: "missing",
              when: { fieldId: "title", operator: "equals", values: ["Workshop"] },
              routeTo: { status: "missing_status" },
            },
          ],
          version: 4,
        },
        3,
      ),
    ).rejects.toThrow("CFP_ROUTE_STATUS_NOT_CONFIGURED");
    await repository.savePublished(
      { ...routedForm, version: 3 },
      false,
      { ...routedForm, version: 3 }.version,
    );
    await expect(
      proposals.saveStatuses(
        form.eventId,
        (await proposals.listStatuses(form.eventId)).filter(({ key }) => key !== "workshop_queue"),
      ),
    ).rejects.toThrow("Configured statuses must include every status currently in use");
    await expect(repository.saveForm({ ...routedForm, version: 4 }, 3)).resolves.toBe(true);
    await repository.savePublished({ ...form, version: 3 }, false, { ...form, version: 3 }.version);
    await expect(
      proposals.saveStatuses(
        form.eventId,
        (await proposals.listStatuses(form.eventId)).filter(({ key }) => key !== "workshop_queue"),
      ),
    ).rejects.toThrow("Configured statuses must include every status currently in use");
    await repository.savePublished(
      { ...routedForm, version: 3 },
      false,
      { ...routedForm, version: 3 }.version,
    );
    const proposal = {
      id: "00000000-0000-4000-8000-000000000111",
      eventId: form.eventId,
      cfpVersion: 3,
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
    const routed = await repository.createSubmission({
      ...proposal,
      id: "00000000-0000-4000-8000-000000000049",
      idempotencyKey: "routed-workshop",
      resolvedRoute: { ruleId: "workshops", status: "workshop_queue" },
    });
    expect(routed?.resolvedRoute).toEqual({ ruleId: "workshops", status: "workshop_queue" });
    await expect(
      repository.createSubmission({
        ...proposal,
        id: "00000000-0000-4000-8000-000000000050",
        idempotencyKey: "invalid-route",
        resolvedRoute: { ruleId: "typo", status: "under_reveiw" },
      }),
    ).rejects.toThrow("CFP_ROUTE_STATUS_NOT_CONFIGURED");
    await expect(proposals.list(form.eventId, "workshop_queue")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: routed?.id, status: "workshop_queue" }),
      ]),
    );
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
    await expect(
      repository.savePublished(
        { ...form, status: "closed", publishedStatus: "closed", version: 4 },
        true,
        4,
      ),
    ).resolves.toBe(true);
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
