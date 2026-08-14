// @acceptance ACC-CFP
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1CfpDatabasePort,
  D1CfpRepository,
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
import { applySeedData, createMigratedDatabase, statements } from "./support/seeded-d1";

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
      // An unbounded call: the window is live state on the row and every existing assertion in
      // this file is about a call with no deadline. The scheduled cases are their own test below.
      opensAt: null,
      closesAt: null,
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
      // Anonymous: an address typed into a public form owns nothing, which is what keeps a
      // decision message for this proposal on the guest path rather than on the account one.
      submitterUserId: null,
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

  /**
   * The sibling of `GAP-025` outside content, found by the sweep issue #202 asked for.
   *
   * `transitionAtomically` reads the proposals, then batches an audit `INSERT … SELECT` and an
   * `UPDATE`, both conditional on `WHERE event_id = ? AND id = ?` — and it answers with the rows
   * it read, rewritten to the new status. A statement that matched nothing is `success: true`
   * exactly like one that landed, so without the affected-row count this reported every proposal
   * transitioned and every audit row written, from a batch that wrote neither.
   *
   * Driven through the port rather than by deleting a submission, because nothing in the product
   * deletes one and the subject here is the adapter's reading of the driver's answer. The real
   * statements still run against real D1; only the counts they come back with are replaced.
   */
  it("refuses a proposal transition whose statements matched no submission", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-transition-count", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database as D1ProposalDatabasePort;
    const eventId = "00000000-0000-4000-8000-000000000001";
    const proposalId = "10000000-0000-4000-8000-000000000002";
    // A fresh audit id per attempt: `cfp_status_audit.id` is a primary key, and a reused one
    // would refuse the batch for a reason that has nothing to do with the row count.
    let audit = 0;
    const transition = (input: { eventId: string; proposalIds: readonly string[] }) => ({
      ...input,
      toStatus: "accepted" as const,
      actorId: "seed-organizer",
      occurredAt: "2026-08-10T12:00:00.000Z",
      auditIds: input.proposalIds.map(
        () => `c0000000-0000-4000-8000-${String(++audit).padStart(12, "0")}`,
      ),
    });

    // The honest baseline: a real transition over real rows reports the new status.
    await expect(
      new D1SubmittedProposalAdapter(database).transitionAtomically(
        transition({ eventId, proposalIds: [proposalId] }),
      ),
    ).resolves.toMatchObject([{ id: proposalId, status: "accepted" }]);

    const withCounts = (changes: readonly number[]): D1ProposalDatabasePort => ({
      prepare: (query) => database.prepare(query),
      batch: async <T>(statements: Parameters<D1ProposalDatabasePort["batch"]>[0]) =>
        (await database.batch<T>(statements)).map((result, index) => ({
          ...result,
          meta: { changes: changes[index] ?? 1 },
        })),
    });

    // The audit row landed nowhere: a transition whose trail is missing is precisely the claim
    // this domain must not make, so the whole act is refused rather than trimmed.
    await expect(
      new D1SubmittedProposalAdapter(withCounts([0, 1])).transitionAtomically(
        transition({ eventId, proposalIds: [proposalId] }),
      ),
      // The whole message, not only the half that survived the repair: it tells an operator this
      // needs checking rather than retrying, and a revert to "retry to converge" — guidance that
      // cannot work, because the retry refuses before reaching the write — would pass an
      // assertion on the first clause alone.
    ).rejects.toThrow(/matched no submission[\s\S]*needs checking rather than retrying/);

    // And the update itself, asserted on the same whole message rather than its first clause.
    await expect(
      new D1SubmittedProposalAdapter(withCounts([1, 0])).transitionAtomically(
        transition({ eventId, proposalIds: [proposalId] }),
      ),
    ).rejects.toThrow(/matched no submission[\s\S]*needs checking rather than retrying/);

    // A driver that will not say how many rows it touched is refused too, rather than read as
    // either zero or one — the whole contract in `d1-write-result.ts`.
    const silent: D1ProposalDatabasePort = {
      prepare: (query) => database.prepare(query),
      batch: async <T>(statements: Parameters<D1ProposalDatabasePort["batch"]>[0]) =>
        (await database.batch<T>(statements)).map(({ results, success, error }) => ({
          ...(results ? { results } : {}),
          success,
          ...(error ? { error } : {}),
        })),
    };
    await expect(
      new D1SubmittedProposalAdapter(silent).transitionAtomically(
        transition({ eventId, proposalIds: [proposalId] }),
      ),
    ).rejects.toThrow(/reported no row count/);
  });

  it("finds a closing call against real storage, including after its form is edited", async () => {
    /*
     * `listDeadlineNotices` had no integration test, and that is exactly how it shipped filtering
     * on the wrong column: `published_at` is the **editable draft's** timestamp, cleared by every
     * `saveForm`, not an "is published" flag. The memory fake read the same wrong field, so no
     * unit test could expose it — only the real schema and the real write path can, which is what
     * this case is for.
     *
     * The sequence is the ordinary organizer one: publish, set a deadline, then fix a typo.
     */
    const migrated = await createMigratedDatabase({ label: "cfp-deadline-notices", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CfpRepository(database as D1CfpDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";
    const published = {
      eventId,
      title: "Share what you learned",
      description: "Submit a practical session.",
      fields: [],
      routing: [],
      status: "open" as const,
      version: 2,
      publishedAt: "2026-08-10T00:00:00.000Z",
      publishedStatus: "open" as const,
      opensAt: null,
      closesAt: null,
    };
    await repository.saveForm(published, 1);
    await repository.savePublished(published, true, published.version);
    await repository.saveWindow(eventId, {
      opensAt: null,
      closesAt: "2026-09-02T06:59:00.000Z",
    });
    const window = { from: "2026-08-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

    await expect(repository.listDeadlineNotices(window, 50)).resolves.toEqual([
      { eventId, closesAt: "2026-09-02T06:59:00.000Z", draftHolders: [] },
    ]);

    // One draft save, exactly as `CfpService.save` issues it: `publishedAt` goes to null.
    await repository.saveForm(
      { ...published, description: "Corrected.", version: 3, publishedAt: null },
      2,
    );

    // Still visible. Filtering on `published_at` returns nothing here, and the scheduler would
    // report `considered: 0` for ever — indistinguishable from "nothing was due".
    await expect(repository.listDeadlineNotices(window, 50)).resolves.toEqual([
      { eventId, closesAt: "2026-09-02T06:59:00.000Z", draftHolders: [] },
    ]);

    // And a call outside the window is not reported, so the filter is doing work in both
    // directions rather than answering "everything".
    await expect(
      repository.listDeadlineNotices(
        { from: "2027-01-01T00:00:00.000Z", to: "2027-02-01T00:00:00.000Z" },
        50,
      ),
    ).resolves.toEqual([]);
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
