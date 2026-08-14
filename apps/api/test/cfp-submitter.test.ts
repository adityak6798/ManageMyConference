// @acceptance ACC-CFP
/*
 * The account-bound half of the call for proposals: the scheduled window, and a proposal that
 * belongs to somebody.
 *
 * Every assertion here is about a rule that has two plausible readings, which is why they are
 * unit tests over the fake rather than browser journeys. Whether the schedule can open a call an
 * organizer closed, whether a draft is held to the required fields, whether a second submitter can
 * tell "not found" from "not yours", and what a stale second tab does to the winning edit are all
 * decisions rather than renderings, and a Playwright assertion on visible text passes happily
 * while any of them is wrong.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import {
  CfpClosedError,
  type CfpNotificationPort,
  CfpDraftConflictError,
  CfpProposalNotFoundError,
  CfpProposalStateConflictError,
  CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "../src/application/cfp/cfp-service";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";

const organizer: Actor = {
  id: "seed-organizer",
  name: "Olivia Organizer",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(),
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["events:settings:update" as const]) },
  ],
};

/**
 * A submitter holds **no** capability and no event role, deliberately.
 *
 * That is what these tests are pinning: a person proposing a talk is not staffed on the
 * conference, so nothing about a proposal write may depend on an event grant. If a future change
 * makes one of these paths call `requireEventCapability`, every test below fails.
 */
const submitter = (id: string, name: string): Actor => ({
  id,
  name,
  persona: "public",
  organizations: [],
  capabilities: new Set(),
  eventAccess: [],
});
const pat = submitter("user-pat", "Pat Attendee");
const sam = submitter("user-sam", "Sam Speaker");

const fields = [
  {
    id: "title",
    type: "short_text" as const,
    label: "Talk title",
    guidance: "",
    required: true,
    options: [],
  },
  {
    id: "abstract",
    type: "long_text" as const,
    label: "Abstract",
    guidance: "",
    required: true,
    options: [],
  },
  {
    id: "email",
    type: "email" as const,
    label: "Contact email",
    guidance: "",
    required: false,
    options: [],
  },
];

const complete = {
  title: "Idempotent conference workflows",
  abstract: "A practical session about reliable submissions.",
  email: "pat@example.test",
};

/** A published, open call, plus a clock the test moves by hand. */
async function open(options: { notifications?: CfpNotificationPort } = {}) {
  let clock = new Date("2026-08-10T12:00:00.000Z");
  let sequence = 0;
  const repository = new MemoryCfpRepository();
  const service = new CfpService(
    repository,
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    () => clock,
    undefined,
    options.notifications,
  );
  await service.save(organizer, {
    eventId,
    title: "Speak",
    description: "",
    fields,
    expectedVersion: 0,
  });
  await service.changeState(organizer, eventId, "publish");
  return {
    service,
    repository,
    at: (instant: string) => {
      clock = new Date(instant);
    },
  };
}

describe("the scheduled submission window", () => {
  it("keeps a call shut before it opens and after it closes, and says which", async () => {
    const { service, at } = await open();
    await service.saveWindow(organizer, eventId, {
      opensAt: "2026-09-01T00:00:00.000Z",
      closesAt: "2026-09-30T23:59:00.000Z",
    });

    // Before the opening: `scheduled`, which is a different message from `closed` — "come back on
    // the 1st" against "you have missed it" — and the refusal carries which one it was.
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      effectiveStatus: "scheduled",
    });
    // The anonymous door answers `404 NOT_FOUND` whichever way the call is shut, which is
    // the code it documented before this issue. The distinction between "come back on the 1st" and
    // "you have missed it" is carried on the *read* asserted above, which every public surface
    // makes before it renders the form — and on the account-bound routes, which are new and so
    // free to answer 409 with the state attached.
    const early = await service.submit(eventId, "too-early", complete).then(
      () => null,
      (error: unknown) => error,
    );
    expect(early).toBeInstanceOf(CfpUnavailableError);
    // The *sentence* still distinguishes the two closures even though the code does not. The
    // translation that pins the status for compatibility rethrows a different error class, and a
    // first version of it replaced the message with a fixed "closed" — telling a guest who
    // arrived a month early that they had missed it, which is the one thing this domain says
    // never to do.
    expect((early as Error).message).toMatch(/not open for submissions yet/);

    at("2026-09-15T09:00:00.000Z");
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      effectiveStatus: "open",
    });
    await expect(service.submit(eventId, "in-window", complete)).resolves.toMatchObject({
      lifecycle: "submitted",
    });

    at("2026-10-01T09:00:00.000Z");
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      effectiveStatus: "closed",
    });
    // 404 on the anonymous door, which is the code it documented before this issue: see
    // `cfp-service.test.ts` for why the better 409 is not taken here.
    await expect(service.submit(eventId, "too-late", complete)).rejects.toBeInstanceOf(
      CfpUnavailableError,
    );
  });

  it("normalises whatever instant it is given, because storage compares these as text", async () => {
    const { service } = await open();
    // The same instant in three spellings. `1201`'s guards compare `closes_at` to a bound
    // `toISOString()` value lexicographically, and that is only chronological order while every
    // stored value has the identical fixed-width UTC shape.
    for (const spelling of [
      "2026-09-30T21:59:00.000Z",
      "2026-09-30T23:59:00+02:00",
      "2026-09-30T21:59:00Z",
    ])
      await expect(
        service.saveWindow(organizer, eventId, { opensAt: null, closesAt: spelling }),
      ).resolves.toMatchObject({ closesAt: "2026-09-30T21:59:00.000Z" });
  });

  it("refuses a routing rule that would announce a decision nobody recorded", async () => {
    const statuses = {
      listStatuses: async () => [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "accepted", label: "Accepted", sortOrder: 90 },
        { key: "declined", label: "Declined", sortOrder: 91 },
      ],
    };
    const repository = new MemoryCfpRepository();
    const service = new CfpService(
      repository,
      () => crypto.randomUUID(),
      () => new Date("2026-08-10T12:00:00.000Z"),
      statuses,
    );
    const routed = (status: string) => ({
      eventId,
      title: "Speak",
      description: "",
      fields,
      routing: [
        {
          id: "keynote",
          when: { fieldId: "title", operator: "notEmpty" as const, values: [] },
          routeTo: { status },
        },
      ],
      expectedVersion: 0,
    });

    /*
     * `accepted` is configured on every event (migration `0021`), so it passed the "is this a
     * configured status" check and was offered in the composer's dropdown. Reaching it is the
     * *effect* of a recorded decision, and the submitter's dashboard now reads that status — so
     * such a rule told an applicant they were accepted with no decision, no session and nobody
     * having decided.
     */
    await expect(service.save(organizer, routed("accepted"))).rejects.toThrow(/cannot route to/);
    await expect(service.save(organizer, routed("declined"))).rejects.toThrow(/cannot route to/);
    // An ordinary triage destination is unaffected.
    await expect(service.save(organizer, routed("submitted"))).resolves.toMatchObject({
      status: "draft",
    });
  });

  it("ignores a decision route already stored, rather than announcing it", async () => {
    // A rule saved before `save` refused them is still in a published snapshot. The submission
    // takes no route at all, so the proposal lands in the default status and the submitter is told
    // "under consideration" — refusing the submission instead would punish the applicant for the
    // organizer's configuration.
    const repository = new MemoryCfpRepository();
    const service = new CfpService(
      repository,
      () => crypto.randomUUID(),
      () => new Date("2026-08-10T12:00:00.000Z"),
    );
    await repository.saveForm(
      {
        eventId,
        title: "Speak",
        description: "",
        fields,
        routing: [
          {
            id: "legacy",
            when: { fieldId: "title", operator: "notEmpty", values: [] },
            routeTo: { status: "accepted" },
          },
        ],
        status: "open",
        version: 1,
        publishedAt: "2026-08-01T00:00:00.000Z",
        publishedStatus: "open",
        opensAt: null,
        closesAt: null,
      },
      0,
    );
    await repository.savePublished(
      {
        eventId,
        title: "Speak",
        description: "",
        fields,
        routing: [
          {
            id: "legacy",
            when: { fieldId: "title", operator: "notEmpty", values: [] },
            routeTo: { status: "accepted" },
          },
        ],
        status: "open",
        version: 1,
        publishedAt: "2026-08-01T00:00:00.000Z",
        publishedStatus: "open",
        opensAt: null,
        closesAt: null,
      },
      false,
      1,
    );
    const submitted = await service.submit(eventId, "legacy-route", complete);
    expect(submitted.resolvedRoute).toBeNull();
    expect(submitted.status).toBe("submitted");
  });

  it("refuses a window that closes before it opens", async () => {
    const { service } = await open();
    await expect(
      service.saveWindow(organizer, eventId, {
        opensAt: "2026-09-30T00:00:00.000Z",
        closesAt: "2026-09-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CfpValidationError);
  });

  it("refuses a reopen the schedule would immediately undo, and names the fix", async () => {
    const { service, at } = await open();
    await service.saveWindow(organizer, eventId, {
      opensAt: null,
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    await service.changeState(organizer, eventId, "close");
    at("2026-10-02T09:00:00.000Z");

    // A 200 here would report "Published · open" over a form that still refuses every submission.
    await expect(service.changeState(organizer, eventId, "reopen")).rejects.toBeInstanceOf(
      CfpStateError,
    );
    await expect(service.changeState(organizer, eventId, "reopen")).rejects.toThrow(
      /deadline has passed/,
    );

    // Moving the deadline is the act that actually reopens the call, and it works.
    await service.saveWindow(organizer, eventId, {
      opensAt: null,
      closesAt: "2026-11-30T23:59:00.000Z",
    });
    await expect(service.changeState(organizer, eventId, "reopen")).resolves.toMatchObject({
      effectiveStatus: "open",
    });
  });

  it("lets a future opening be scheduled on a call the organizer had closed", async () => {
    const { service } = await open();
    await service.changeState(organizer, eventId, "close");
    await service.saveWindow(organizer, eventId, {
      opensAt: "2026-12-01T00:00:00.000Z",
      closesAt: null,
    });
    // Reopening then scheduling the opening is a real intention, so it is not refused — and the
    // call correctly reads `scheduled` rather than `open` until that instant arrives.
    await expect(service.changeState(organizer, eventId, "reopen")).resolves.toMatchObject({
      effectiveStatus: "scheduled",
    });
  });

  it("cannot be opened by the schedule alone once the organizer has closed it", async () => {
    const { service } = await open();
    await service.saveWindow(organizer, eventId, {
      opensAt: "2026-08-01T00:00:00.000Z",
      closesAt: "2026-12-31T23:59:00.000Z",
    });
    await service.changeState(organizer, eventId, "close");
    // Both gates have to permit. A window that says "wide open" does not overrule the organizer.
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      effectiveStatus: "closed",
    });
  });

  it("is not part of the form, so publishing a draft neither opens nor moves it", async () => {
    const { service } = await open();
    await service.saveWindow(organizer, eventId, {
      opensAt: null,
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    await service.save(organizer, {
      eventId,
      title: "Typo fixed",
      description: "",
      fields,
      expectedVersion: 1,
    });
    const republished = await service.changeState(organizer, eventId, "publish");
    expect(republished.closesAt).toBe("2026-09-30T23:59:00.000Z");
    // And the deadline reaches applicants without a republish of its own.
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      closesAt: "2026-09-30T23:59:00.000Z",
      title: "Typo fixed",
    });
  });

  it("refuses a window on a call that has no form at all", async () => {
    const service = new CfpService(new MemoryCfpRepository(), crypto.randomUUID, () => new Date());
    await expect(
      service.saveWindow(organizer, eventId, { opensAt: null, closesAt: null }),
    ).rejects.toThrow(/Create the CFP/);
  });
});

describe("a proposal that belongs to an account", () => {
  it("saves a title-only draft, resumes it, and submits it later", async () => {
    const { service } = await open();
    // The whole feature: absent answers are the normal state of something being written, so a
    // draft is held to the form's shape and not to its completeness.
    const draft = await service.createDraft(pat, eventId, "draft-key", { title: "Just a title" });
    expect(draft).toMatchObject({ lifecycle: "draft", state: "draft", submittedAt: null });
    expect(draft.title).toBe("Just a title");

    // "Signs out, signs back in" is exactly a fresh read by the same account.
    const resumed = await service.myProposal(pat, eventId, draft.id);
    expect(resumed.answers).toEqual({ title: "Just a title" });

    const submitted = await service.submitProposal(
      pat,
      eventId,
      draft.id,
      complete,
      resumed.revision,
    );
    expect(submitted).toMatchObject({ lifecycle: "submitted", state: "under_consideration" });
    expect(submitted.submittedAt).toBe("2026-08-10T12:00:00.000Z");
    // One proposal throughout, so the dashboard does not grow a second row on submission.
    await expect(service.myProposals(pat, eventId)).resolves.toHaveLength(1);
  });

  it("holds a draft to the form's shape even while it is incomplete", async () => {
    const { service } = await open();
    // An answer that is *wrong* rather than absent is refused now, because storing it would only
    // move the refusal to the moment they press Submit.
    await expect(
      service.createDraft(pat, eventId, "bad-field", { nonexistent: "x" }),
    ).rejects.toBeInstanceOf(CfpValidationError);
    await expect(
      service.createDraft(pat, eventId, "bad-email", { email: "not-an-address" }),
    ).rejects.toBeInstanceOf(CfpValidationError);
    await expect(
      service.createDraft(pat, eventId, "too-long", { title: "x".repeat(201) }),
    ).rejects.toBeInstanceOf(CfpValidationError);
  });

  it("requires the whole form on submission, and on an edit to something already submitted", async () => {
    const { service } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", { title: "Only a title" });
    await expect(
      service.submitProposal(pat, eventId, draft.id, { title: "Only a title" }, draft.revision),
    ).rejects.toBeInstanceOf(CfpValidationError);

    const submitted = await service.submitProposal(
      pat,
      eventId,
      draft.id,
      complete,
      draft.revision,
    );
    // A submitted proposal is in front of reviewers: an edit that emptied a required answer would
    // leave them reading something the form itself would have refused.
    await expect(
      service.saveProposal(pat, eventId, submitted.id, { title: "Still here" }, submitted.revision),
    ).rejects.toBeInstanceOf(CfpValidationError);
  });

  it("refuses to submit the same proposal twice", async () => {
    const { service } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    const submitted = await service.submitProposal(
      pat,
      eventId,
      draft.id,
      complete,
      draft.revision,
    );
    // A conflict with the resource's state — 409 — rather than a `CfpStateError`, which the
    // transport answers 400 "your input was wrong" about a proposal the applicant already sent.
    await expect(
      service.submitProposal(pat, eventId, submitted.id, complete, submitted.revision),
    ).rejects.toBeInstanceOf(CfpProposalStateConflictError);
  });

  it("converges a retried create on the draft the first attempt made", async () => {
    const { service } = await open();
    const first = await service.createDraft(pat, eventId, "same-key", { title: "One" });
    const retry = await service.createDraft(pat, eventId, "same-key", { title: "One" });
    expect(retry.id).toBe(first.id);
    await expect(service.myProposals(pat, eventId)).resolves.toHaveLength(1);
  });

  it("never hands one account's proposal to another that names the same idempotency key", async () => {
    const { service } = await open();
    /*
     * The key is caller-supplied and `UNIQUE (event_id, idempotency_key)` is not owner-scoped, so
     * the second `INSERT OR IGNORE` is a no-op and everything then depends on what the convergence
     * read is scoped to. Unscoped, it answered Sam with Pat's proposal — id, answers and all — with
     * a 201. Two review passes reproduced exactly this.
     */
    const mine = await service.createDraft(pat, eventId, "shared-key", {
      title: "Pat's unsent proposal",
    });
    const theirs = await service.createDraft(sam, eventId, "shared-key", { title: "Sam's own" });

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.answers).toEqual({ title: "Sam's own" });
    expect(JSON.stringify(theirs)).not.toContain("Pat's unsent proposal");
    // Each account sees one proposal: its own.
    await expect(service.myProposals(pat, eventId)).resolves.toMatchObject([
      { answers: { title: "Pat's unsent proposal" } },
    ]);
    await expect(service.myProposals(sam, eventId)).resolves.toMatchObject([
      { answers: { title: "Sam's own" } },
    ]);
  });

  it("does not answer a guest with somebody's unsent draft when the keys collide", async () => {
    const { service } = await open();
    const draft = await service.createDraft(pat, eventId, "guest-collision", { title: "Private" });
    // An anonymous retry converges only on an anonymous, already-submitted proposal. Reading the
    // key unscoped returned this draft's id as a confirmation for something nobody submitted.
    const guest = await service.submit(eventId, "guest-collision", complete);
    expect(guest.id).not.toBe(draft.id);
    expect(guest.submitterUserId).toBeNull();
    expect(guest.answers).toEqual(complete);
    // And the draft is untouched and still Pat's.
    await expect(service.myProposal(pat, eventId, draft.id)).resolves.toMatchObject({
      answers: { title: "Private" },
      lifecycle: "draft",
    });
  });

  it("answers a second submitter's read and write exactly as it answers an unknown id", async () => {
    const { service } = await open();
    const mine = await service.createDraft(pat, eventId, "mine", { title: "Mine" });

    // Indistinguishable on purpose: a submitter who could tell the two apart could enumerate
    // another submitter's proposal ids.
    await expect(service.myProposal(sam, eventId, mine.id)).rejects.toBeInstanceOf(
      CfpProposalNotFoundError,
    );
    await expect(
      service.myProposal(sam, eventId, "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toBeInstanceOf(CfpProposalNotFoundError);
    await expect(
      service.saveProposal(sam, eventId, mine.id, { title: "Stolen" }, mine.revision),
    ).rejects.toBeInstanceOf(CfpProposalNotFoundError);
    await expect(
      service.submitProposal(sam, eventId, mine.id, complete, mine.revision),
    ).rejects.toBeInstanceOf(CfpProposalNotFoundError);

    // And nothing was written by any of that.
    await expect(service.myProposals(sam, eventId)).resolves.toEqual([]);
    await expect(service.myProposal(pat, eventId, mine.id)).resolves.toMatchObject({
      answers: { title: "Mine" },
    });
  });

  it("refuses every proposal path to a caller with no account at all", async () => {
    const { service } = await open();
    for (const call of [
      () => service.myProposals(null, eventId),
      () => service.createDraft(null, eventId, "anon-draft", { title: "x" }),
      () => service.myProposal(null, eventId, "00000000-0000-4000-8000-000000000001"),
      () => service.saveProposal(null, eventId, "00000000-0000-4000-8000-000000000001", {}, 1),
      () =>
        service.submitProposal(null, eventId, "00000000-0000-4000-8000-000000000001", complete, 1),
    ])
      await expect(call()).rejects.toThrow(/Sign in/);
  });

  it("refuses a stale second tab without replacing the winning edit", async () => {
    const { service } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", { title: "Original" });
    // Two tabs read the same revision; one of them writes first.
    const winner = await service.saveProposal(
      pat,
      eventId,
      draft.id,
      { title: "Winning edit" },
      draft.revision,
    );
    await expect(
      service.saveProposal(pat, eventId, draft.id, { title: "Stale edit" }, draft.revision),
    ).rejects.toBeInstanceOf(CfpDraftConflictError);
    // The loser's refusal is data-loss-free in the direction that matters: the winner survives.
    await expect(service.myProposal(pat, eventId, draft.id)).resolves.toMatchObject({
      answers: { title: "Winning edit" },
      revision: winner.revision,
    });
  });

  it("locks proposals once the deadline passes, and still shows them", async () => {
    const { service, at } = await open();
    await service.saveWindow(organizer, eventId, {
      opensAt: null,
      closesAt: "2026-09-30T23:59:00.000Z",
    });
    const draft = await service.createDraft(pat, eventId, "k1", { title: "In time" });
    at("2026-10-01T00:00:00.000Z");

    for (const call of [
      () => service.createDraft(pat, eventId, "k2", { title: "Late" }),
      () => service.saveProposal(pat, eventId, draft.id, { title: "Late edit" }, draft.revision),
      () => service.submitProposal(pat, eventId, draft.id, complete, draft.revision),
    ])
      await expect(call()).rejects.toBeInstanceOf(CfpClosedError);

    // Reading is not writing: the dashboard is a record after the call closes.
    await expect(service.myProposals(pat, eventId)).resolves.toMatchObject([
      { id: draft.id, answers: { title: "In time" } },
    ]);
  });

  it("tells the submitter's own account, and only for an account-bound submission", async () => {
    const proposalSubmitted = vi.fn(() => Promise.resolve());
    const { service } = await open({ notifications: { proposalSubmitted } });
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    await service.submitProposal(pat, eventId, draft.id, complete, draft.revision);

    // The user id and nothing address-shaped: resolving it to a mailbox is the composition root's
    // job through identity, which is the whole of what makes this message safe under #132.
    expect(proposalSubmitted).toHaveBeenCalledTimes(1);
    expect(proposalSubmitted).toHaveBeenCalledWith({
      eventId,
      proposalId: draft.id,
      submitterUserId: pat.id,
      proposalTitle: complete.title,
    });
    expect(JSON.stringify(proposalSubmitted.mock.calls)).not.toContain("@");

    // Saving a revision afterwards is not a second submission and must not confirm again.
    const submitted = await service.myProposal(pat, eventId, draft.id);
    await service.saveProposal(
      pat,
      eventId,
      draft.id,
      { ...complete, title: "Retitled" },
      submitted.revision,
    );
    expect(proposalSubmitted).toHaveBeenCalledTimes(1);
  });

  it("leaves an anonymous submission unowned, unconfirmed, and off every dashboard", async () => {
    const proposalSubmitted = vi.fn(() => Promise.resolve());
    const { service } = await open({ notifications: { proposalSubmitted } });
    const anonymous = await service.submit(eventId, "guest-key", complete);

    expect(anonymous.submitterUserId).toBeNull();
    // Nothing was told, because there is no verified address to tell — which is the property
    // decision D5 refused to ship a confirmation without.
    expect(proposalSubmitted).not.toHaveBeenCalled();
    // And an address in the answers buys ownership of nothing: neither account can reach it.
    for (const account of [pat, sam]) {
      await expect(service.myProposals(account, eventId)).resolves.toEqual([]);
      await expect(service.myProposal(account, eventId, anonymous.id)).rejects.toBeInstanceOf(
        CfpProposalNotFoundError,
      );
    }
  });

  it("tells a guest whose write lost a race what happened, in the status code it always used", async () => {
    /*
     * Two things this endpoint gets right for different reasons.
     *
     * `createSubmission` returns null for several reasons and every one is a conflict with the
     * resource's *state* rather than a fault in the request — so `409` is the right code, and it
     * is what the account-bound routes this issue adds give. This one keeps `400`, because that
     * is what it answered before the issue and `api-compatibility.md` makes repurposing a status
     * code a breaking change with a 180-day window behind it. The code is compatibility; the
     * sentence is correctness, and the sentence was what was actually wrong: it borrowed
     * `createDraft`'s and told a guest who raced a republish that the call had closed while it
     * was open.
     */
    const { service, repository } = await open();
    vi.spyOn(repository, "createSubmission").mockResolvedValue(null);

    const refusal = await service.submit(eventId, "guest-key", complete).then(
      () => null,
      (error: unknown) => error,
    );
    /*
     * `CfpStateError` — 400 — because that is what this endpoint documented, not because 400 is
     * right. Every cause of this miss is a conflict with the resource's state, so 409 is the
     * better code and the account-bound routes give it; changing this one is breaking under
     * `api-compatibility.md` and needs its 180-day window.
     */
    expect(refusal).toBeInstanceOf(CfpStateError);
    /*
     * The sentence is asserted, because it is the whole of what the guest is given.
     *
     * `effectiveState` rides on the error but the transport's envelope carries only code, message
     * and status — so no surface can distinguish the causes, and the message must not claim one.
     * It said "closed", which is the one thing that is *not* true here: the call is open and an
     * immediate retry would have worked.
     */
    expect((refusal as CfpClosedError).message).toBe(
      "This call for proposals changed before the proposal was saved. Reload the form and try again.",
    );
    expect((refusal as CfpClosedError).message).not.toMatch(/closed/);
  });

  it("confirms a submission that committed even when the read-back after it fails", async () => {
    /*
     * Ordering, asserted — because the repair that established it changed no output.
     *
     * `submitProposal` reads the proposal, writes, announces, then reads it back for the view it
     * returns. When the announcement came *after* that second read, a transient read failure
     * answered 500 over a write that had already committed — and submitting is one-way, so the
     * applicant's retry is refused with "already submitted" and no confirmation is ever queued.
     * Moving `announce` above the read-back is invisible to every other test: the happy path
     * produces the same call with the same arguments either way. This is the case that tells them
     * apart, and it fails against the original ordering.
     */
    const proposalSubmitted = vi.fn(() => Promise.resolve());
    const { service, repository } = await open({ notifications: { proposalSubmitted } });
    const draft = await service.createDraft(pat, eventId, "k1", complete);

    // The first read is the ownership check before the write; the second is the read-back after
    // it. Only the second fails, which is what makes this a post-commit failure rather than a
    // refusal to start.
    const real = repository.findProposalForOwner.bind(repository);
    let reads = 0;
    vi.spyOn(repository, "findProposalForOwner").mockImplementation(async (...args) => {
      reads += 1;
      if (reads > 1) throw new Error("D1 read failed after the write committed");
      return real(...args);
    });

    await expect(
      service.submitProposal(pat, eventId, draft.id, complete, draft.revision),
    ).rejects.toThrow("D1 read failed");

    // The 500 still happens — this does not make a failed read succeed. What it changes is that
    // the applicant has already been confirmed, which is the part that could never be recovered.
    expect(proposalSubmitted).toHaveBeenCalledTimes(1);
    expect(proposalSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: draft.id, submitterUserId: pat.id }),
    );
  });

  it("blames the submission rather than the deadline when a write loses to its own submit", async () => {
    /*
     * The branch that has to be added whenever a predicate is added to the guarded write — and
     * the order that decides whether it does anything.
     *
     * `explainRefusedWrite` reaches its last sentence by elimination, so a new member of the
     * write's conjunction with no branch produces a confident wrong *sentence* rather than a
     * wrong code: a proposal that had just been submitted was reported as a call that had closed.
     * Order matters as much as presence. Every lifecycle change also advances `revision`, so
     * checking revision first answers both realistic races — a double-click on Submit, and a
     * revision that lost to a concurrent submit — with "this changed in another tab", telling the
     * applicant to reload a draft that is no longer a draft. Lifecycle is therefore checked first,
     * which cannot mis-answer: a lifecycle mismatch is never merely a stale revision.
     *
     * Both cases are driven here rather than one, because a first version of this test reached the
     * branch only through a combination no client produces.
     */
    const { service, repository } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    // Captured while it is still a draft, so the spy below can hold a read back to this moment.
    const stale = await repository.findProposalForOwner(eventId, draft.id, pat.id);
    await service.submitProposal(pat, eventId, draft.id, complete, draft.revision);

    // A double-click on Submit: the second call carries the revision the first one read.
    const resubmit = await service
      .submitProposal(pat, eventId, draft.id, complete, draft.revision)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(resubmit).toBeInstanceOf(CfpProposalStateConflictError);
    expect((resubmit as Error).message).toMatch(/already been submitted/);
    expect((resubmit as Error).message).not.toMatch(/closed|another tab/);

    /*
     * And the write that loses to the submit, rather than the *read* that does.
     *
     * A revision whose own read already sees the submitted row is a plain stale-revision conflict
     * and is reported as one — correctly. The write's lifecycle predicate is for the narrower case
     * where the row moves between the request's read and its write, which needs the read to be
     * held back: the first one returns the pre-submit snapshot and everything after it is real.
     */
    const real = repository.findProposalForOwner.bind(repository);
    let reads = 0;
    vi.spyOn(repository, "findProposalForOwner").mockImplementation(async (...args) => {
      reads += 1;
      return reads === 1 ? stale : real(...args);
    });

    // Revision **1** — what a client that read the draft actually sends. Passing the post-submit
    // revision instead makes the revision predicate match, so the order of the two checks stops
    // mattering and the test passes against either: that is how the first version of this let the
    // reorder revert silently.
    const revised = await service.saveProposal(pat, eventId, draft.id, complete, 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(revised).toBeInstanceOf(CfpProposalStateConflictError);
    expect((revised as Error).message).toMatch(/already been submitted/);
    // Not the deadline, and not "another tab": both send the applicant somewhere unhelpful.
    expect((revised as Error).message).not.toMatch(/closed|another tab/);
  });

  it("keeps a revised draft following the live form rather than freezing one", async () => {
    /*
     * The other half of the snapshot rule, and the one it is easy to break while fixing the first.
     *
     * A submitted proposal is named from its own snapshot, because it has met a published form and
     * everything downstream reads it through that. A **draft** has not, so it is named from the
     * live form — and freezing a snapshot on its first revision would name it from a question the
     * organizer has since replaced, which is exactly what `viewOf`'s invariant exists to avoid.
     * Writing `form.fields` on every revision quietly ended that.
     */
    const { service, repository } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    const [saved] = await service.myProposals(pat, eventId);
    await service.saveProposal(pat, eventId, draft.id, complete, saved?.revision as number);

    // Revised, and still holding no snapshot of its own — which is what makes `viewOf` read the
    // live form for it. Asserted on the stored row rather than on the rendered title, because a
    // title can coincide: `proposalTitleOf` falls back through the answers, so a draft frozen
    // against the old form and one following the live one can print the same string while
    // disagreeing about everything that matters after the next republish.
    await expect(repository.findProposalForOwner(eventId, draft.id, pat.id)).resolves.toMatchObject(
      {
        lifecycle: "draft",
        fields: [],
        revision: 2,
      },
    );
  });

  it("keeps naming a submitted proposal after the form moves on beneath it", async () => {
    const { service } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    await service.submitProposal(pat, eventId, draft.id, complete, draft.revision);
    // The organizer replaces the question the title came from.
    await service.save(organizer, {
      eventId,
      title: "Speak",
      description: "",
      fields: [
        {
          id: "headline",
          type: "short_text",
          label: "Headline",
          guidance: "",
          required: true,
          options: [],
        },
      ],
      expectedVersion: 1,
    });
    await service.changeState(organizer, eventId, "publish");
    // The submitted proposal carries its own field snapshot, so its name survives.
    await expect(service.myProposals(pat, eventId)).resolves.toMatchObject([
      { title: complete.title },
    ]);
  });

  it("moves the field snapshot with a revision, so a republished form does not empty the proposal", async () => {
    /*
     * The half of the case above that the snapshot alone does not cover.
     *
     * A revision is validated against the form as published *now* — `validateAnswers` refuses any
     * key the current form does not name — so after a republish the applicant *must* send the new
     * keys. Writing those answers under the old snapshot leaves a row whose keys match nothing in
     * its own `form_fields_json`, and every projection reads an answer by looking its field up
     * there. The proposal then reads as `Proposal <uuid>` / "See submitted answers." with no
     * answers and no submitter in triage and in every reviewer's queue, and the decision
     * notification resolves no address at all.
     *
     * `submitProposal` always carried both; `saveProposalAnswers` did not, which is the sibling
     * defect.
     */
    const { service, repository } = await open();
    const draft = await service.createDraft(pat, eventId, "k1", complete);
    await service.submitProposal(pat, eventId, draft.id, complete, draft.revision);

    // A routine edit: the same question, renamed. Version 1 → 2.
    await service.save(organizer, {
      eventId,
      title: "Speak",
      description: "",
      fields: [
        {
          id: "headline",
          type: "short_text",
          label: "Headline",
          guidance: "",
          required: true,
          options: [],
        },
      ],
      expectedVersion: 1,
    });
    await service.changeState(organizer, eventId, "publish");

    const [before] = await service.myProposals(pat, eventId);
    await service.saveProposal(
      pat,
      eventId,
      draft.id,
      { headline: "Answered against the new form" },
      before?.revision as number,
    );

    // The dashboard names it from the snapshot, so a stale one shows the old question's answer.
    await expect(service.myProposals(pat, eventId)).resolves.toMatchObject([
      { title: "Answered against the new form" },
    ]);
    // And the stored row itself, which is what the organizer and reviewer projections read: the
    // snapshot names the question the stored answer key belongs to, and records the version.
    await expect(repository.findProposalForOwner(eventId, draft.id, pat.id)).resolves.toMatchObject(
      {
        cfpVersion: 2,
        fields: [{ id: "headline" }],
        answers: { headline: "Answered against the new form" },
      },
    );
  });
});
