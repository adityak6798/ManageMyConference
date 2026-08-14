// @acceptance ACC-CFP
// @spec PRD-COM-001 PRD-CFP-003
/**
 * Issue #210: somebody is told a deadline is coming, and the organizer is told when it has gone.
 *
 * Every assertion here is about *what is written and how often*, because the whole risk of a
 * scheduled message is the cron: it fires every sixty seconds, so anything that is not idempotent
 * mails a person fourteen hundred times a day. There is no bookkeeping table — the idempotency key
 * is the record — so the second-tick assertions are the design under test, not a nicety.
 */
import { describe, expect, it } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import {
  deadlineInZone,
  enqueueCfpDeadlineNotices,
} from "../src/application/communications/cfp-deadline-notices";
import { CommunicationsService } from "../src/application/communications/communications-service";
import type { CfpForm, ProposalSubmission } from "../src/domain/cfp/cfp";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const LA = "America/Los_Angeles";
const NOW = new Date("2026-09-01T12:00:00.000Z");

const form = (closesAt: string | null, publishedAt: string | null = "2026-08-01T00:00:00.000Z") =>
  ({
    eventId,
    title: "Share what you learned",
    description: "Submit a practical session.",
    fields: [],
    routing: [],
    status: "open",
    version: 3,
    publishedAt,
    publishedStatus: "open",
    opensAt: null,
    closesAt,
  }) as unknown as CfpForm;

/** One proposal, written through the repository's own create so nothing bypasses its guards. */
const WRITTEN_AT = "2026-08-20T12:00:00.000Z";

/**
 * Fill a repository with a published call and the proposals on it.
 *
 * The call is opened with a far-future deadline first and the real one is set afterwards through
 * `saveWindow`, because a draft can only be created while the call is taking submissions — which
 * is the product's own rule and the reason this fixture does not reach into the repository's
 * internals to plant rows it would refuse.
 */
async function populate(
  cfp: MemoryCfpRepository,
  options: {
    closesAt: string | null;
    publishedAt: string | null;
    drafts: readonly (string | null)[];
    submittedBy: readonly string[];
  },
) {
  // `savePublished`, not `saveForm`: a draft can only be written against a call that is actually
  // published and open, which is the guard the product enforces and the fixture must satisfy.
  await cfp.savePublished(form("2099-01-01T00:00:00.000Z", options.publishedAt), true, 0);
  let proposal = 0;
  const create = (submitterUserId: string) =>
    cfp.createDraft({
      id: `proposal-${++proposal}`,
      eventId,
      cfpVersion: 3,
      idempotencyKey: `proposal-${proposal}`,
      answers: {},
      fields: [],
      resolvedRoute: null,
      submittedAt: WRITTEN_AT,
      submitterUserId,
      lifecycle: "draft",
      revision: 1,
      updatedAt: WRITTEN_AT,
      status: "draft",
      at: WRITTEN_AT,
    } as never);
  for (const holder of options.drafts) {
    // A guest proposal has no account. `createDraft` is account-bound by construction, so the
    // guest row is planted the only way the product can produce one — as an anonymous submission.
    if (holder === null)
      await cfp.createSubmission({
        id: `guest-${++proposal}`,
        eventId,
        cfpVersion: 3,
        idempotencyKey: `guest-${proposal}`,
        answers: {},
        fields: [],
        resolvedRoute: null,
        submittedAt: WRITTEN_AT,
        submitterUserId: null,
        lifecycle: "submitted",
        revision: 1,
        updatedAt: WRITTEN_AT,
        status: "submitted",
      } as never);
    else await create(holder);
  }
  for (const holder of options.submittedBy) {
    const created = await create(holder);
    await cfp.submitProposal({
      eventId,
      proposalId: created?.id ?? "",
      submitterUserId: holder,
      answers: {},
      expectedRevision: 1,
      updatedAt: WRITTEN_AT,
      at: WRITTEN_AT,
      cfpVersion: 3,
      fields: [],
      resolvedRoute: null,
      status: "submitted",
      submittedAt: WRITTEN_AT,
    });
  }
  await cfp.saveWindow(eventId, { opensAt: null, closesAt: options.closesAt });
}

/**
 * The scheduler with real storage behind the enqueue, because the idempotency key's whole job is
 * done by the unique index the memory repository reproduces.
 */
async function harness(
  options: {
    closesAt?: string | null;
    publishedAt?: string | null;
    drafts?: readonly (string | null)[];
    submittedBy?: readonly string[];
    addresses?: Record<string, string | null>;
    organizers?: readonly { id: string; name: string; email: string | null }[];
    now?: Date;
  } = {},
) {
  const cfp = new MemoryCfpRepository();
  await populate(cfp, {
    closesAt: options.closesAt === undefined ? "2026-09-02T06:59:00.000Z" : options.closesAt,
    publishedAt:
      options.publishedAt === undefined ? "2026-08-01T00:00:00.000Z" : options.publishedAt,
    drafts: options.drafts ?? [],
    submittedBy: options.submittedBy ?? [],
  });
  const repository = new MemoryCommunicationsRepository();
  let id = 0;
  const service = new CommunicationsService({
    repository,
    eventDirectory: { belongsToOrganization: async () => true },
    newId: () => `id-${++id}`,
    now: () => options.now ?? NOW,
  });
  const failures: Record<string, unknown>[] = [];
  const run = () =>
    enqueueCfpDeadlineNotices({
      calls: cfp,
      enqueue: service,
      eventOf: async () => ({ organizationId, name: "Greenroom Demo Summit", timezone: LA }),
      findRecipient: async (userId) => ({
        id: userId,
        name: `Person ${userId}`,
        email: options.addresses ? (options.addresses[userId] ?? null) : `${userId}@example.test`,
      }),
      organizersOf: async () =>
        options.organizers ?? [{ id: "seed-organizer", name: "Olivia", email: "olivia@test.test" }],
      now: () => options.now ?? NOW,
      onFailure: (fields) => failures.push(fields),
    });
  return { run, repository, failures, organizationId };
}

const sent = async (repository: MemoryCommunicationsRepository) =>
  (await repository.list(organizationId, eventId)).map(
    ({ triggerType, recipientRef, renderedSubject }) => ({
      triggerType,
      recipientRef,
      renderedSubject,
    }),
  );

describe("the scheduled CFP deadline messages", () => {
  it("reminds an account holding an unsubmitted draft, once, before the deadline", async () => {
    const test = await harness({ drafts: ["user-pat"] });

    const first = await test.run();
    const second = await test.run();

    expect(first).toMatchObject({ considered: 1, reminded: 1, announced: 0 });
    // The second tick is the assertion the design exists for: the key is the record, so nothing
    // new is written and nothing is sent again.
    expect(second).toMatchObject({ considered: 1, reminded: 0, announced: 0 });
    expect(await sent(test.repository)).toEqual([
      {
        triggerType: "cfp.deadline_approaching",
        recipientRef: "user-pat@example.test",
        renderedSubject: "Your draft for Greenroom Demo Summit is not submitted yet",
      },
    ]);
  });

  it("sends nothing to an account that has submitted everything it wrote", async () => {
    // The other half of the acceptance: reminded before submitting, silent afterwards. The query
    // filters on `lifecycle`, so a submitted proposal simply is not a draft holder.
    const test = await harness({ submittedBy: ["user-pat"] });

    expect(await test.run()).toMatchObject({ considered: 1, reminded: 0, announced: 0 });
    expect(await sent(test.repository)).toEqual([]);
  });

  it("never reminds a guest, because a guest has no account to address", async () => {
    /*
     * A guest proposal carries a form answer and no account. `#132` is the reason that address is
     * not a recipient here: nobody has proven they control it, and a scheduled message to it would
     * be a send primitive on a public form. The query drops them; this is the guard.
     */
    const test = await harness({ drafts: [null, "user-pat"] });

    await test.run();

    expect(await sent(test.repository)).toEqual([
      expect.objectContaining({ recipientRef: "user-pat@example.test" }),
    ]);
  });

  it("tells the organizer once when the deadline has passed, and reminds nobody then", async () => {
    const test = await harness({ closesAt: "2026-09-01T06:59:00.000Z", drafts: ["user-pat"] });

    const first = await test.run();
    const second = await test.run();

    expect(first).toMatchObject({ considered: 1, reminded: 0, announced: 1 });
    expect(second).toMatchObject({ considered: 1, reminded: 0, announced: 0 });
    expect(await sent(test.repository)).toEqual([
      {
        triggerType: "cfp.call_closed",
        recipientRef: "olivia@test.test",
        renderedSubject: "Your call for proposals has closed",
      },
    ]);
  });

  it("treats a moved deadline as a new fact rather than a repeat of the old one", async () => {
    /*
     * The occurrence in the key is the deadline instant, not the day the scheduler ran. So an
     * organizer who moves a deadline gets a second message about the second deadline — which is
     * correct, because it is a different promise to the same applicant — while a scheduler that
     * ran a thousand times against one unchanged deadline sends exactly one.
     */
    const cfp = new MemoryCfpRepository();
    await populate(cfp, {
      closesAt: "2026-09-02T06:59:00.000Z",
      publishedAt: "2026-08-01T00:00:00.000Z",
      drafts: ["user-pat"],
      submittedBy: [],
    });
    const repository = new MemoryCommunicationsRepository();
    let id = 0;
    const service = new CommunicationsService({
      repository,
      eventDirectory: { belongsToOrganization: async () => true },
      newId: () => `id-${++id}`,
      now: () => NOW,
    });
    const run = () =>
      enqueueCfpDeadlineNotices({
        calls: cfp,
        enqueue: service,
        eventOf: async () => ({ organizationId, name: "Greenroom Demo Summit", timezone: LA }),
        findRecipient: async (userId) => ({
          id: userId,
          name: "Pat",
          email: "pat@example.test",
        }),
        organizersOf: async () => [],
        now: () => NOW,
      });

    await run();
    // The window is live state with its own writer, which is exactly how an organizer moves a
    // deadline: no republish, no new version.
    await cfp.saveWindow(eventId, { opensAt: null, closesAt: "2026-09-02T20:00:00.000Z" });
    const afterMove = await run();

    expect(afterMove).toMatchObject({ reminded: 1 });
    expect(await repository.list(organizationId, eventId)).toHaveLength(2);
  });

  it("says nothing about a call nobody published", async () => {
    // An unpublished call has no applicants and no deadline anybody has seen; a message about it
    // would announce something that was never offered.
    const test = await harness({ publishedAt: null, drafts: ["user-pat"] });

    expect(await test.run()).toMatchObject({ considered: 0, reminded: 0, announced: 0 });
  });

  it("reports an account identity holds no address for, rather than mailing an empty string", async () => {
    const test = await harness({ drafts: ["user-pat"], addresses: { "user-pat": null } });

    await test.run();

    expect(await sent(test.repository)).toEqual([]);
    expect(test.failures).toEqual([
      expect.objectContaining({ userId: "user-pat", reason: "no address for this account" }),
    ]);
  });

  it("keeps going, and reports, when the read of closing calls fails", async () => {
    /*
     * This runs from `scheduled()` before the outbox drain. A storage failure propagating out of
     * here would leave every queued delivery unsent until the read started working again —
     * reminders taking the outbox down with them, which is the failure `task-reminders.ts`
     * documents and this repeats.
     */
    const failures: Record<string, unknown>[] = [];
    const result = await enqueueCfpDeadlineNotices({
      calls: {
        listDeadlineNotices: async () => {
          throw new Error("D1 unavailable");
        },
      },
      enqueue: {
        enqueue: async () => {
          throw new Error("should not be reached");
        },
      } as never,
      eventOf: async () => null,
      findRecipient: async () => null,
      organizersOf: async () => [],
      now: () => NOW,
      onFailure: (fields) => failures.push(fields),
    });

    expect(result).toEqual({ considered: 0, reminded: 0, announced: 0 });
    expect(failures).toEqual([
      expect.objectContaining({ reason: "closing calls could not be read" }),
    ]);
  });

  it("states the deadline in the event's zone, never in the server's", () => {
    // A deadline is a wall-clock promise made on a public page. Restating it in another zone is
    // telling the applicant a different deadline.
    expect(deadlineInZone("2026-10-01T06:59:00.000Z", LA)).toContain("September 30, 2026");
    expect(deadlineInZone("2026-10-01T06:59:00.000Z", LA)).toContain("PDT");
    expect(deadlineInZone("2026-10-01T06:59:00.000Z", "Europe/Berlin")).toContain(
      "October 1, 2026",
    );
    // An unusable zone falls back to the instant rather than to nothing: the applicant still has
    // to be told the call is closing.
    expect(deadlineInZone("2026-10-01T06:59:00.000Z", "Not/AZone")).toBe(
      "2026-10-01T06:59:00.000Z",
    );
  });
});
