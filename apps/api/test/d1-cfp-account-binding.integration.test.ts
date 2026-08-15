// @acceptance ACC-CFP
/*
 * What only a real database can answer about account-bound proposals.
 *
 * Three classes of claim live here and nowhere else. The **guards in SQL** — every proposal write
 * carries the open-window condition in its own WHERE clause, so a call an organizer closes between
 * a request's read and its write refuses the write rather than accepting a late answer. The
 * **triggers** from migration `1201`, which make a draft's shape a property of the database rather
 * than of the service that happens to write it. And the **invisibility of a draft** to every read
 * path of the organizer and reviewer projection, enumerated here so that a fifth read path added
 * later without the predicate fails a test instead of leaking a proposal nobody submitted.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1CfpRepository,
  type D1CfpDatabasePort,
} from "../src/adapters/persistence/d1-cfp-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import type { CfpField, CfpForm } from "../src/domain/cfp/cfp";
import { createMigratedDatabase } from "./support/seeded-d1";

const eventId = "00000000-0000-4000-8000-000000000001";
const PAT = "seed-public";
const SAM = "seed-speaker";

const form: CfpForm = {
  eventId,
  title: "CFP",
  description: "",
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Title",
      guidance: "",
      required: true,
      options: [],
    },
  ],
  routing: [],
  status: "open",
  version: 2,
  publishedAt: "2026-08-10T00:00:00.000Z",
  publishedStatus: "open",
  opensAt: null,
  closesAt: null,
};

const draftOf = (id: string, owner: string, at: string, key: string) => ({
  id,
  eventId,
  cfpVersion: form.version,
  idempotencyKey: key,
  answers: { title: `Draft ${id}` },
  fields: [],
  resolvedRoute: null,
  submittedAt: at,
  updatedAt: at,
  lifecycle: "draft" as const,
  revision: 1,
  status: "cfp:draft",
  submitterUserId: owner,
  at,
});

const AT = "2026-08-10T12:00:00.000Z";

describe("D1: the submission window in SQL", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  /** A seeded database whose CFP is published and open, with the window under test applied. */
  async function published(window: { opensAt: string | null; closesAt: string | null }) {
    const migrated = await createMigratedDatabase({ label: "cfp-window", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CfpRepository(migrated.database as D1CfpDatabasePort);
    await repository.saveForm(form, 1);
    await repository.savePublished(form, true, form.version);
    await repository.saveWindow(eventId, window);
    return { repository, database: migrated.database };
  }

  it("keeps the window on the row and out of the published snapshot", async () => {
    const { repository, database } = await published({
      opensAt: null,
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    // A copy in the snapshot would be a second, silently stale answer to "when does this close".
    const stored = await database
      .prepare("SELECT published_json, closes_at FROM cfp_forms WHERE event_id = ?")
      .bind(eventId)
      .all<{ published_json: string; closes_at: string }>();
    const snapshot = JSON.parse(stored.results?.[0]?.published_json ?? "{}");
    expect(snapshot).not.toHaveProperty("closesAt");
    expect(stored.results?.[0]?.closes_at).toBe("2026-09-30T23:59:00.000Z");
    // And every read overlays the columns, so an old snapshot needs no backfill.
    await expect(repository.findPublished(eventId)).resolves.toMatchObject({
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    await expect(repository.findForm(eventId)).resolves.toMatchObject({
      closesAt: "2026-09-30T23:59:00.000Z",
    });
  });

  it("refuses an anonymous submission after the deadline, comparing instants as text", async () => {
    const { repository } = await published({
      opensAt: "2026-09-01T00:00:00.000Z",
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    const attempt = (id: string, at: string, key: string) =>
      repository.createSubmission({
        id,
        eventId,
        cfpVersion: form.version,
        idempotencyKey: key,
        answers: { title: "Hello" },
        fields: form.fields,
        resolvedRoute: null,
        submittedAt: at,
        updatedAt: at,
        lifecycle: "submitted",
        submitterUserId: null,
      });

    // The comparison is lexicographic, which is only chronological while every value has the
    // canonical fixed-width UTC shape — the reason `CfpService` normalises through `Date`.
    await expect(
      attempt("20000000-0000-4000-8000-000000000001", "2026-08-20T09:00:00.000Z", "early"),
    ).resolves.toBeNull();
    await expect(
      attempt("20000000-0000-4000-8000-000000000002", "2026-09-15T09:00:00.000Z", "inside"),
    ).resolves.toMatchObject({ lifecycle: "submitted" });
    await expect(
      attempt("20000000-0000-4000-8000-000000000003", "2026-10-01T09:00:00.000Z", "late"),
    ).resolves.toBeNull();
    // The instant the window closes is not inside it: `closes_at > ?` rather than `>=`.
    await expect(
      attempt("20000000-0000-4000-8000-000000000004", "2026-09-30T23:59:00.000Z", "exact"),
    ).resolves.toBeNull();
  });

  it("refuses a proposal write when the call closes between the read and the write", async () => {
    const { repository, database } = await published({ opensAt: null, closesAt: null });
    const draft = await repository.createDraft(
      draftOf("20000000-0000-4000-8000-000000000010", PAT, AT, "pat-1"),
    );
    expect(draft).not.toBeNull();

    // The organizer closes the call. The service has already read an open form; only the guard
    // inside the write can see this.
    await database
      .prepare(
        "UPDATE cfp_forms SET published_json = json_set(published_json, '$.status', 'closed') WHERE event_id = ?",
      )
      .bind(eventId)
      .run();

    const write = {
      eventId,
      proposalId: "20000000-0000-4000-8000-000000000010",
      submitterUserId: PAT,
      answers: { title: "Late edit" },
      expectedRevision: 1,
      updatedAt: AT,
      at: AT,
      cfpVersion: form.version,
      fields: form.fields,
      lifecycle: "draft" as const,
    };
    await expect(repository.saveProposalAnswers(write)).resolves.toBe(false);
    await expect(
      repository.submitProposal({
        ...write,
        resolvedRoute: null,
        status: "submitted",
        submittedAt: AT,
      }),
    ).resolves.toBe(false);
    // Nothing was written by either refusal.
    await expect(
      repository.findProposalForOwner(eventId, write.proposalId, PAT),
    ).resolves.toMatchObject({ answers: { title: "Draft 20000000-0000-4000-8000-000000000010" } });
  });

  /*
   * The convergence *read*, pinned on its own.
   *
   * `CfpService` namespaces an owned proposal's stored key by its owner, so two accounts cannot
   * collide through the service at all — which means the service-level regression test would still
   * pass if this scoping were reverted. That is the wrong shape for the half that actually failed:
   * the defect two reviewers reproduced was an unscoped read answering one account with another's
   * row, and it lives here. So this drives the repository directly, with a key deliberately shared,
   * which is the arrangement the namespacing exists to prevent and this predicate exists to survive.
   */
  it("answers a create with nothing when another account already holds that key", async () => {
    const { repository } = await published({ opensAt: null, closesAt: null });
    const shared = "deliberately-shared-key";
    const mine = await repository.createDraft(
      draftOf("20000000-0000-4000-8000-000000000040", PAT, AT, shared),
    );
    expect(mine).toMatchObject({ submitterUserId: PAT });

    // `INSERT OR IGNORE` is skipped for the duplicate key whoever owns it, so everything depends on
    // what the read that follows is scoped to. Unscoped, this returned Pat's row to Sam with a 201.
    await expect(
      repository.createDraft(draftOf("20000000-0000-4000-8000-000000000041", SAM, AT, shared)),
    ).resolves.toBeNull();
    await expect(repository.listProposalsForOwner(eventId, SAM)).resolves.toEqual([]);

    // The same in the other direction: an anonymous retry naming an owned key converges on nothing
    // rather than confirming a proposal nobody submitted.
    await expect(
      repository.createSubmission({
        id: "20000000-0000-4000-8000-000000000042",
        eventId,
        cfpVersion: form.version,
        idempotencyKey: shared,
        answers: { title: "Guest" },
        fields: form.fields,
        resolvedRoute: null,
        submittedAt: AT,
        updatedAt: AT,
        lifecycle: "submitted",
        submitterUserId: null,
      }),
    ).resolves.toBeNull();

    // And the owner's own retry still converges, which is what the key is for.
    await expect(
      repository.createDraft(draftOf("20000000-0000-4000-8000-000000000043", PAT, AT, shared)),
    ).resolves.toMatchObject({ id: "20000000-0000-4000-8000-000000000040" });
  });

  it("scopes every proposal write to its owner and its revision", async () => {
    const { repository } = await published({ opensAt: null, closesAt: null });
    const id = "20000000-0000-4000-8000-000000000020";
    await repository.createDraft(draftOf(id, PAT, AT, "pat-1"));

    // Another account, and a stale revision, are the same kind of miss: no row matches.
    await expect(
      repository.saveProposalAnswers({
        eventId,
        proposalId: id,
        submitterUserId: SAM,
        answers: { title: "Stolen" },
        expectedRevision: 1,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        lifecycle: "draft" as const,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.saveProposalAnswers({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Stale" },
        expectedRevision: 7,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        lifecycle: "draft" as const,
      }),
    ).resolves.toBe(false);
    await expect(repository.findProposalForOwner(eventId, id, SAM)).resolves.toBeNull();
    // The owner at the right revision writes, and the revision advances.
    await expect(
      repository.saveProposalAnswers({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Mine" },
        expectedRevision: 1,
        updatedAt: "2026-08-10T13:00:00.000Z",
        at: AT,
        // A later form than the row was created against. The statement has to move the snapshot
        // with the answers, or the stored keys stop matching the stored fields and every
        // projection that reads an answer through them renders an empty proposal.
        cfpVersion: form.version + 1,
        fields: [{ ...(form.fields[0] as CfpField), id: "renamed", label: "Renamed" }],
        lifecycle: "draft" as const,
      }),
    ).resolves.toBe(true);
    await expect(repository.findProposalForOwner(eventId, id, PAT)).resolves.toMatchObject({
      answers: { title: "Mine" },
      revision: 2,
      updatedAt: "2026-08-10T13:00:00.000Z",
      // The snapshot travelled with the answers rather than staying on the form the row was
      // created against.
      cfpVersion: form.version + 1,
      fields: [{ id: "renamed", label: "Renamed" }],
    });
  });

  it("discovers participant invitations by normalized address inside structured JSON", async () => {
    const { repository } = await published({ opensAt: null, closesAt: null });
    const invited = {
      ...draftOf("50000000-0000-4000-8000-000000000099", PAT, AT, "participant-invite"),
      participants: [
        {
          id: "10000000-0000-4000-8000-000000000099",
          name: "Inez Invited",
          email: "inez@example.test",
          role: "co_speaker" as const,
          state: "pending" as const,
        },
      ],
    };
    await expect(repository.createDraft(invited)).resolves.toMatchObject({ id: invited.id });
    await expect(
      repository.listParticipantInvitations(eventId, " INEZ@EXAMPLE.TEST "),
    ).resolves.toMatchObject([{ id: invited.id, participants: invited.participants }]);
    await expect(
      repository.listParticipantInvitations(eventId, "other@example.test"),
    ).resolves.toEqual([]);
  });
});

describe("D1: a draft is not a submission", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  async function withDraft() {
    const migrated = await createMigratedDatabase({ label: "cfp-draft", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CfpRepository(migrated.database as D1CfpDatabasePort);
    const proposals = new D1SubmittedProposalAdapter(migrated.database as D1ProposalDatabasePort);
    await repository.saveForm(form, 1);
    await repository.savePublished(form, true, form.version);
    const id = "20000000-0000-4000-8000-000000000030";
    const draft = await repository.createDraft(draftOf(id, PAT, AT, "pat-draft"));
    expect(draft).not.toBeNull();
    return { repository, proposals, database: migrated.database, id };
  }

  it("is invisible to every read path of the organizer and reviewer projection", async () => {
    const { proposals, id } = await withDraft();
    // Enumerated deliberately. A draft reaching any one of these appears in triage, in a
    // reviewer's queue, in a status count or in an accept — looking like a submission nobody sent.
    expect((await proposals.list(eventId)).map((item) => item.id)).not.toContain(id);
    expect((await proposals.list(eventId, "draft")).map((item) => item.id)).not.toContain(id);
    expect((await proposals.list(eventId, "submitted")).map((item) => item.id)).not.toContain(id);
    await expect(proposals.find(eventId, id)).resolves.toBeNull();
    await expect(proposals.findMany(eventId, [id])).resolves.toEqual([]);
    // Nor can it be transitioned: `transitionAtomically` reads through `findMany`, so a draft is
    // not a proposal it can move — which is what stops a draft being accepted.
    await expect(
      proposals.transitionAtomically({
        eventId,
        proposalIds: [id],
        toStatus: "under_review",
        actorId: "seed-organizer",
        occurredAt: AT,
        auditIds: ["30000000-0000-4000-8000-000000000001"],
      }),
    ).rejects.toThrow();
    // And it stays reachable by the person writing it.
    await expect(proposals.listStatuses(eventId)).resolves.not.toContainEqual(
      expect.objectContaining({ key: "draft" }),
    );
  });

  it("becomes visible the moment it is submitted, carrying its answers", async () => {
    const { repository, proposals, id } = await withDraft();
    await expect(
      repository.submitProposal({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Round-tripped" },
        expectedRevision: 1,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        resolvedRoute: null,
        status: "submitted",
        submittedAt: AT,
      }),
    ).resolves.toBe(true);
    await expect(proposals.find(eventId, id)).resolves.toMatchObject({
      id,
      title: "Round-tripped",
      status: "submitted",
    });
    // The one-way door: a submitted proposal cannot revert to a draft and vanish from review.
    await expect(repository.createDraft(draftOf(id, PAT, AT, "pat-draft"))).resolves.toMatchObject({
      lifecycle: "submitted",
    });
  });

  it("carries the owning account into every projection review reads", async () => {
    /*
     * Because a decision message is addressed from it.
     *
     * `decisionRecorded` reports `submitterUserId` so the composition root can prefer the address
     * identity holds for that account over the `email`-typed form answer nobody verified — the
     * exposure issue #132 describes. That preference is only as good as this column arriving,
     * and it arrives through three separate statements: `list` feeds triage, `findMany` feeds the
     * bulk decide, and `find` feeds the single one. A `SELECT` that forgot the column on one of
     * them would silently send that path's decisions to the unverified address, and every other
     * assertion in this file would still pass.
     */
    const { repository, proposals, id } = await withDraft();
    await expect(
      repository.submitProposal({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Owned all the way through" },
        expectedRevision: 1,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        resolvedRoute: null,
        status: "submitted",
        submittedAt: AT,
      }),
    ).resolves.toBe(true);

    await expect(proposals.find(eventId, id)).resolves.toMatchObject({ submitterUserId: PAT });
    await expect(proposals.findMany(eventId, [id])).resolves.toMatchObject([
      { submitterUserId: PAT },
    ]);
    // The seeded event holds other proposals, so this names the row rather than the position.
    expect((await proposals.list(eventId)).find((row) => row.id === id)).toMatchObject({
      submitterUserId: PAT,
    });
  });

  it("refuses a write that names a lifecycle the row has moved on from", async () => {
    /*
     * The predicate that makes "which snapshot does this write store" safe to decide from a read.
     *
     * A submitted proposal stores the form it was validated against; a draft stores none, so it
     * is named from the live form. That branch is chosen from a row read *before* the write, and
     * the caller supplies the expected revision — so without a lifecycle predicate a revision
     * naming a number the row has not reached yet lands the draft branch on a row a concurrent
     * submit has already moved to `submitted`, blanking `form_fields_json`. Every organizer and
     * reviewer projection resolves an answer through that snapshot, so the proposal renders empty
     * in triage and in every queue, and the `email`-typed answer the decision notification is
     * addressed from goes with it.
     *
     * Here the row is submitted at revision 2; a write that still believes it is a draft matches
     * nothing, which is a refusal its caller already knows how to explain.
     */
    const { repository, id } = await withDraft();
    await expect(
      repository.submitProposal({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Submitted" },
        expectedRevision: 1,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        resolvedRoute: null,
        status: "submitted",
        submittedAt: AT,
      }),
    ).resolves.toBe(true);

    // The draft branch, at the revision the row now holds. Right owner, right revision, open
    // call — and still refused, because the row is no longer the thing this write describes.
    await expect(
      repository.saveProposalAnswers({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Written as a draft" },
        expectedRevision: 2,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: [],
        lifecycle: "draft" as const,
      }),
    ).resolves.toBe(false);

    // The snapshot the submission stored is intact, which is the thing that was at risk.
    await expect(repository.findProposalForOwner(eventId, id, PAT)).resolves.toMatchObject({
      lifecycle: "submitted",
      revision: 2,
      fields: form.fields,
    });

    /*
     * And the submit statement's own precondition, which is fixed rather than supplied.
     *
     * Submitting is one-way, so this row cannot be submitted again — at the right owner, the
     * right revision and an open call. Worth its own assertion because the guard briefly became a
     * bound value and nothing failed: `1201`'s no-regression trigger only refuses
     * `submitted` → `draft`, so a second submit would have re-stamped `submitted_at`, re-resolved
     * the route and earned a second confirmation with the database entirely happy.
     */
    await expect(
      repository.submitProposal({
        eventId,
        proposalId: id,
        submitterUserId: PAT,
        answers: { title: "Submitted twice" },
        expectedRevision: 2,
        updatedAt: AT,
        at: AT,
        cfpVersion: form.version,
        fields: form.fields,
        resolvedRoute: null,
        status: "submitted",
        submittedAt: "2026-08-10T18:00:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(repository.findProposalForOwner(eventId, id, PAT)).resolves.toMatchObject({
      revision: 2,
      submittedAt: AT,
    });
  });

  it("shows the organizer's decision on the owner's proposal and nobody else's", async () => {
    const { repository, proposals, id } = await withDraft();
    await repository.submitProposal({
      eventId,
      proposalId: id,
      submitterUserId: PAT,
      answers: { title: "Decided" },
      expectedRevision: 1,
      updatedAt: AT,
      at: AT,
      cfpVersion: form.version,
      fields: form.fields,
      resolvedRoute: null,
      status: "submitted",
      submittedAt: AT,
    });
    // The real acceptance path: review moves the triage status through the CFP interface.
    await proposals.transitionAtomically({
      eventId,
      proposalIds: [id],
      toStatus: "accepted",
      actorId: "seed-organizer",
      occurredAt: AT,
      auditIds: ["30000000-0000-4000-8000-000000000002"],
    });
    await expect(repository.findProposalForOwner(eventId, id, PAT)).resolves.toMatchObject({
      status: "accepted",
    });
    // The seed's own submissions are anonymous, so an accepted proposal that *names* a seeded
    // speaker in its answers still belongs to nobody's account — an address on a form buys
    // ownership of nothing (`#132`).
    await expect(repository.listProposalsForOwner(eventId, SAM)).resolves.toEqual([]);
    expect((await repository.listProposalsForOwner(eventId, PAT)).map((item) => item.id)).toEqual([
      id,
    ]);
  });
});

/*
 * Where the submission confirmation's *content* is asserted, and why not here.
 *
 * The obvious place was a case in this file reading the seeded `proposal-submitted` template out of
 * `message_templates` and rendering it against the payload the port supplies. `message_templates`
 * belongs to communications, and the context integrity gate refuses a CFP-owned file that reads
 * another domain's table — correctly, because that is how a domain quietly acquires a dependency on
 * a schema it does not own.
 *
 * So the assertion lives in `apps/web/e2e/cfp-submitter.spec.ts` instead, against communications'
 * own delivery history: the confirmation's rendered body names the proposal, and its recipient is
 * the address the *session's* account is linked to rather than the one the applicant typed into the
 * form. That is a stronger statement than rendering the template in isolation would have been, and
 * it reads the surface an operator would.
 */

describe("D1: migration 1201's guards", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  /** Insert a proposal row directly, so a guard can be met without going through an adapter. */
  async function insertRow(
    database: Awaited<ReturnType<typeof createMigratedDatabase>>["database"],
    row: Record<string, string | number | null>,
  ) {
    const columns = Object.keys(row);
    return database
      .prepare(
        `INSERT INTO cfp_submissions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .bind(...columns.map((column) => row[column] ?? null))
      .run();
  }

  const base = {
    event_id: eventId,
    cfp_version: 1,
    answers_json: "{}",
    form_fields_json: "[]",
    submitted_at: AT,
    updated_at: AT,
  };

  it("refuses a draft with no owner, and a lifecycle that disagrees with the status", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-guards", seed: true });
    runtime = migrated.runtime;
    // An unowned draft is unreachable by anybody — no dashboard lists it and no write can name it.
    await expect(
      insertRow(migrated.database, {
        ...base,
        id: "40000000-0000-4000-8000-000000000001",
        idempotency_key: "unowned-draft",
        status: "cfp:draft",
        lifecycle: "draft" as const,
        submitter_user_id: null,
      }),
    ).rejects.toThrow(/CFP_PROPOSAL_LIFECYCLE_INVALID/);
    // A row marked submitted while carrying the draft status, or the reverse, is the divergence
    // every reader's lifecycle predicate would then disagree with the status filter about.
    await expect(
      insertRow(migrated.database, {
        ...base,
        id: "40000000-0000-4000-8000-000000000002",
        idempotency_key: "half-draft",
        status: "cfp:draft",
        lifecycle: "submitted",
        submitter_user_id: PAT,
      }),
    ).rejects.toThrow(/CFP_PROPOSAL_LIFECYCLE_INVALID/);
    await expect(
      insertRow(migrated.database, {
        ...base,
        id: "40000000-0000-4000-8000-000000000003",
        idempotency_key: "half-submitted",
        status: "submitted",
        lifecycle: "draft" as const,
        submitter_user_id: PAT,
      }),
    ).rejects.toThrow(/CFP_PROPOSAL_LIFECYCLE_INVALID/);
  });

  it("holds the default triage status open while a draft still needs it", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-default-status", seed: true });
    runtime = migrated.runtime;
    /*
     * Submitting a draft is an `UPDATE` that sets `status = 'submitted'`, and `0011` aborts it
     * unless that key is still configured. `0013` only self-heals on *insert*, and the
     * in-use guard looks for a submission carrying the key — which a draft does not, since it
     * carries `cfp:draft`. So on an event whose proposals are all drafts, deleting `submitted`
     * used to leave the applicant's Submit failing with a trigger name.
     */
    /*
     * On the second seeded event, first move its one submitted proposal off `submitted` so the
     * *pre-existing* in-use guard (`0012`) has nothing to object to — otherwise this would pass
     * for the wrong reason and prove nothing about the guard added here.
     */
    const secondEvent = "00000000-0000-4000-8000-000000000002";
    await migrated.database
      .prepare("UPDATE cfp_submissions SET status = 'accepted' WHERE event_id = ?")
      .bind(secondEvent)
      .run();
    const withoutDraft = await migrated.database
      .prepare("DELETE FROM cfp_statuses WHERE event_id = ? AND key = 'submitted'")
      .bind(secondEvent)
      .run();
    expect(withoutDraft.success).toBe(true);

    // Now a draft arrives, which re-creates the key through `0013`'s insert trigger and needs it
    // to survive until the moment it is submitted.
    await insertRow(migrated.database, {
      ...base,
      event_id: secondEvent,
      id: "40000000-0000-4000-8000-000000000030",
      idempotency_key: "draft-holding-status",
      status: "cfp:draft",
      lifecycle: "draft",
      submitter_user_id: PAT,
    });
    await expect(
      migrated.database
        .prepare("DELETE FROM cfp_statuses WHERE event_id = ? AND key = 'submitted'")
        .bind(secondEvent)
        .run(),
    ).rejects.toThrow(/CFP_STATUS_IN_USE/);
  });

  it("refuses to unsubmit a proposal or to move it to another account", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-guards-2", seed: true });
    runtime = migrated.runtime;
    const id = "40000000-0000-4000-8000-000000000010";
    await insertRow(migrated.database, {
      ...base,
      id,
      idempotency_key: "submitted-row",
      status: "submitted",
      lifecycle: "submitted",
      submitter_user_id: PAT,
    });

    await expect(
      migrated.database
        .prepare(
          "UPDATE cfp_submissions SET lifecycle = 'draft', status = 'cfp:draft' WHERE id = ?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/CFP_PROPOSAL_LIFECYCLE_REGRESSION/);
    await expect(
      migrated.database
        .prepare("UPDATE cfp_submissions SET submitter_user_id = ? WHERE id = ?")
        .bind(SAM, id)
        .run(),
    ).rejects.toThrow(/CFP_PROPOSAL_OWNER_IMMUTABLE/);
    // Claiming an anonymous submission is the same write, and refused for the same reason.
    await expect(
      migrated.database
        .prepare(
          "UPDATE cfp_submissions SET submitter_user_id = ? WHERE id = '10000000-0000-4000-8000-000000000001'",
        )
        .bind(SAM)
        .run(),
    ).rejects.toThrow(/CFP_PROPOSAL_OWNER_IMMUTABLE/);
  });

  /*
   * The backfill statement itself is not replayed here, and the reason is worth writing down.
   *
   * Observing it needs a row that predates `1201`, which needs a database built only as far as
   * `1200` — and then an `events` row and an `organizations` row for the foreign keys, both of them
   * tables the events domain owns. The context integrity gate refuses a CFP-owned file that writes
   * another domain's tables, correctly: that is how a domain acquires a silent dependency on a
   * schema it does not own. Building the fixture in the events domain's own suite to test a CFP
   * migration would be worse.
   *
   * What is asserted instead is the end state the backfill exists to produce — every stored
   * proposal has a history rather than a NULL — plus the columns' defaults, which the case below
   * reads off the seeded fixture. `gate:d1` also replays the whole migration list on a fresh
   * database on every run, so the statement is executed; what is untested is only its effect on
   * rows, and the effect is one `UPDATE … WHERE updated_at IS NULL` whose failure mode is a NULL
   * the readers already `COALESCE`.
   *
   * A review pass asked for the replay anyway, so it was written, and it is worth recording what
   * happened rather than only the conclusion. `createMigratedDatabase({ through: "1200_…" })`
   * plus two pre-`1201` rows works and does catch a deleted backfill — but D1 enforces
   * `cfp_submissions`' foreign key to `events`, so it needs an `events` and an `organizations`
   * row, and `npm run context -- check` then reports *Domain 'cfp' reads table 'events' owned by
   * 'events'*. Moving those two inserts into the platform-owned harness only moves the same
   * finding to `platform`. The remaining way through is to put the fixture in a `.sql` file so
   * the table names stop appearing in scanned source, which is defeating the check rather than
   * satisfying it. So the replay was reverted: the gate is right that a CFP file must not depend
   * on the events schema, and the coverage it costs is the one `UPDATE` described above.
   */
  it("leaves every stored proposal with a history and no owner it did not earn", async () => {
    const migrated = await createMigratedDatabase({ label: "cfp-seeded", seed: true });
    runtime = migrated.runtime;
    const rows = await migrated.database
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN submitter_user_id IS NOT NULL THEN 1 ELSE 0 END) AS owned FROM cfp_submissions",
      )
      .all<{ total: number; missing: number; owned: number }>();
    expect(rows.results?.[0]?.total).toBeGreaterThan(0);
    expect(rows.results?.[0]?.missing).toBe(0);
    // And every one of them arrived through the anonymous door, which is what makes the demo
    // fixture evidence for the guest rule rather than a contradiction of it.
    expect(rows.results?.[0]?.owned).toBe(0);
  });
});
