// @acceptance ACC-REVIEW
/*
 * First-class review rounds at the application boundary.
 *
 * The storage guards are driven against real D1 in `d1-review-round-backfill.integration.test.ts`
 * and `d1-review-repository.integration.test.ts`. What is proved here is the half a trigger cannot
 * do: that the refusal an organizer or a reviewer meets *names the round and says why*, that the
 * projection a reviewer receives is chosen by their round's policy rather than by a deployment
 * setting, and that a round's own scorecard is what its scores are validated and weighted against.
 *
 * @spec PRD-REV-001 PRD-ABS-001
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import type { Actor } from "../src/application/identity/actor";
import {
  type ReviewNotificationPort,
  ReviewNotFoundError,
  ReviewService,
  ReviewValidationError,
} from "../src/application/review/review-service";

const eventId = "00000000-0000-4000-8000-000000000001";
const first = "10000000-0000-4000-8000-000000000001";
const second = "10000000-0000-4000-8000-000000000002";
const RAVI = "seed-reviewer";
const NINA = "review-nina-alvarez";

/** The refusal itself, so a test can read the field the server pointed at. */
const refusalOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );
const fieldsOf = (error: unknown) =>
  error instanceof ReviewValidationError ? error.fields : undefined;

/** A reviewer actor for somebody who is not one of the demo personas. */
const reviewerActor = (id: string, name: string): Actor => ({
  id,
  name,
  persona: "reviewer",
  organizations: [],
  capabilities: new Set(["events:read", "review:evaluate"] as const),
  eventAccess: [
    {
      eventId,
      role: "reviewer" as const,
      capabilities: new Set(["events:read", "review:evaluate"] as const),
    },
  ],
});

const proposal = (id: string, title: string) => ({
  id,
  eventId,
  title,
  abstract: `${title} — abstract`,
  submitterName: "Robin Submitter",
  submitter: { name: "Robin Submitter", email: "robin@example.test" },
  submitterUserId: null,
  answers: [
    {
      fieldId: "coauthors",
      label: "Co-authors",
      type: "long_text" as const,
      value: '[{"name":"Avery Chen","role":"Co-presenter"}]',
    },
  ],
  status: "submitted",
});

const build = (now = "2026-08-10T12:00:00.000Z") => {
  let id = 0;
  const repository = new MemoryReviewRepository();
  const reminded: Parameters<ReviewNotificationPort["remindOutstanding"]>[0][] = [];
  const notifications: ReviewNotificationPort = {
    async reviewerAssigned() {},
    async decisionRecorded() {},
    // The real binding keys a delivery on `(event, reviewer, round)`, so a repeat is
    // `already_sent`. The fake answers the same way, because a fake that always said `queued`
    // would let a service bug that reminds somebody twice pass every test in this file.
    async remindOutstanding(fact) {
      const repeat = reminded.some(
        (earlier) =>
          earlier.reviewerId === fact.reviewerId &&
          earlier.round === fact.round &&
          earlier.eventId === fact.eventId,
      );
      reminded.push(fact);
      return repeat ? "already_sent" : "queued";
    },
  };
  const reviewers = [
    { id: RAVI, name: "Ravi Reviewer" },
    { id: NINA, name: "Nina Alvarez" },
  ];
  const service = new ReviewService({
    repository,
    proposals: new MemorySubmittedProposalAdapter([
      proposal(first, "Designing for the hallway track"),
      proposal(second, "Typed boundaries at scale"),
    ]),
    notifications,
    identities: {
      isReviewerForEvent: async (userId, scoped) =>
        scoped === eventId && reviewers.some(({ id: reviewerId }) => reviewerId === userId),
      listReviewersForEvent: async (scoped) => (scoped === eventId ? reviewers : []),
    },
    events: {
      get: async () => ({
        id: eventId,
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Event",
        timezone: "UTC",
        createdAt: "2026-08-09T12:00:00.000Z",
      }),
    },
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date(now),
  });
  return { service, repository, reminded };
};

const PLAN = [
  { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5, weight: 2 },
] as const;
/** A second rubric with a criterion the event plan has never heard of. */
const COMMITTEE = [
  {
    id: "programme_fit",
    name: "Programme fit",
    description: "Balance across the programme",
    minScore: 1,
    maxScore: 5,
    weight: 3,
  },
  {
    id: "delivery",
    name: "Delivery confidence",
    description: "Can they deliver it",
    minScore: 1,
    maxScore: 5,
    weight: 1,
  },
] as const;

describe("review rounds", () => {
  let organizer: Actor;
  let ravi: Actor;
  let nina: Actor;
  beforeEach(async () => {
    organizer = await resolveSeededDemoActor("organizer");
    ravi = await resolveSeededDemoActor("reviewer");
    nina = reviewerActor(NINA, "Nina Alvarez");
  });

  it("answers an unconfigured event with a default round, so nothing that worked before stops", async () => {
    const { service } = build();
    /*
     * The compatibility contract, stated as a test because it is the property most easily lost.
     *
     * Migration `1312` refuses an assignment naming a round that does not exist. An event that has
     * never configured one therefore has to be given a round on the way past, or every caller
     * written before rounds existed — the template slice, the seeded demo, the browser suite —
     * starts failing on a rule about a concept it has never heard of.
     */
    const rounds = await service.listRounds(organizer, eventId);
    expect(rounds).toMatchObject([
      { sequence: 1, name: "Round 1", state: "open", poolMode: "event", criteria: null },
    ]);
    await service.configurePlan(organizer, eventId, [...PLAN]);
    // `event`-pooled, so any reviewer of the event is admissible — which is what was true before.
    const assigned = await service.assign(organizer, eventId, [first], RAVI);
    expect(assigned).toHaveLength(1);
  });

  it("keeps two rounds' dates, scorecards, blind policies and pools apart across a reload", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const firstPass = await service.createRound(organizer, eventId, {
      name: "First pass",
      opensAt: "2026-08-09T00:00:00.000Z",
      closesAt: "2026-12-01T00:00:00.000Z",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI],
    });
    const committee = await service.createRound(organizer, eventId, {
      name: "Programme committee",
      opensAt: "2026-08-10T00:00:00.000Z",
      closesAt: "2026-12-31T00:00:00.000Z",
      state: "open",
      anonymized: false,
      criteria: [...COMMITTEE],
      reviewerIds: [NINA],
    });
    // Sequences are allocated by the server, in order, and the default `Round 1` is sequence 1.
    expect([firstPass.sequence, committee.sequence]).toEqual([2, 3]);

    // Re-read from storage rather than trusting the returned objects: "survive reload" is the
    // acceptance criterion, and a service that answered from its own arguments would pass a
    // weaker test.
    const reloaded = await service.listRounds(organizer, eventId);
    expect(reloaded.map(({ name }) => name)).toEqual([
      "Round 1",
      "First pass",
      "Programme committee",
    ]);
    expect(reloaded[1]).toMatchObject({
      opensAt: "2026-08-09T00:00:00.000Z",
      closesAt: "2026-12-01T00:00:00.000Z",
      anonymized: true,
      criteria: null,
      poolMode: "named",
      reviewerIds: [RAVI],
    });
    expect(reloaded[2]).toMatchObject({
      opensAt: "2026-08-10T00:00:00.000Z",
      closesAt: "2026-12-31T00:00:00.000Z",
      anonymized: false,
      poolMode: "named",
      reviewerIds: [NINA],
    });
    expect(reloaded[2]?.criteria).toEqual([...COMMITTEE]);
  });

  it("does not carry a reviewer from one round's pool into another's", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const firstPass = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI, NINA],
    });
    const committee = await service.createRound(organizer, eventId, {
      name: "Programme committee",
      state: "open",
      anonymized: true,
      reviewerIds: [NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, firstPass.sequence);

    // The acceptance criterion, in one assertion: reviewing round 1 grants nothing in round 2.
    const refusal = await refusalOf(
      service.assign(organizer, eventId, [first], RAVI, committee.sequence),
    );
    expect(refusal).toBeInstanceOf(ReviewValidationError);
    expect(fieldsOf(refusal)?.reviewerId?.join(" ")).toContain("Programme committee");
    expect(fieldsOf(refusal)?.reviewerId?.join(" ")).toContain(
      "membership in one round does not carry into another",
    );

    // Explicitly added, and now admissible. Nothing else changed.
    await service.setRoundPool(organizer, eventId, committee.sequence, [NINA, RAVI]);
    await expect(
      service.assign(organizer, eventId, [first], RAVI, committee.sequence),
    ).resolves.toHaveLength(1);
  });

  it("refuses to remove a reviewer who is holding work in the round", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI, NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, round.sequence);
    const refusal = await refusalOf(
      service.setRoundPool(organizer, eventId, round.sequence, [NINA]),
    );
    // Removing them would leave an assignment authorized by a pool that no longer contains them.
    expect(fieldsOf(refusal)?.reviewerIds?.join(" ")).toContain("cannot be removed");
    // A reviewer who holds nothing leaves freely.
    await expect(
      service.setRoundPool(organizer, eventId, round.sequence, [RAVI]),
    ).resolves.toMatchObject({ reviewerIds: [RAVI] });
  });

  it("refuses work in a round that is a draft, closed, or outside its window", async () => {
    await (async () => {
      const { service } = build();
      await service.configurePlan(organizer, eventId, [...PLAN]);
      const draft = await service.createRound(organizer, eventId, {
        name: "Not started",
        state: "draft",
        anonymized: true,
        reviewerIds: [RAVI],
      });
      const refusal = await refusalOf(
        service.assign(organizer, eventId, [first], RAVI, draft.sequence),
      );
      expect(fieldsOf(refusal)?.round?.join(" ")).toContain("still a draft");
    })();

    await (async () => {
      const { service } = build();
      await service.configurePlan(organizer, eventId, [...PLAN]);
      // Opens tomorrow; the clock says today.
      const later = await service.createRound(organizer, eventId, {
        name: "Later",
        state: "open",
        opensAt: "2026-08-11T00:00:00.000Z",
        anonymized: true,
        reviewerIds: [RAVI],
      });
      const refusal = await refusalOf(
        service.assign(organizer, eventId, [first], RAVI, later.sequence),
      );
      expect(fieldsOf(refusal)?.round?.join(" ")).toContain("does not open until");
    })();

    await (async () => {
      const { service } = build();
      await service.configurePlan(organizer, eventId, [...PLAN]);
      const past = await service.createRound(organizer, eventId, {
        name: "Finished",
        state: "open",
        closesAt: "2026-08-09T00:00:00.000Z",
        anonymized: true,
        reviewerIds: [RAVI],
      });
      const refusal = await refusalOf(
        service.assign(organizer, eventId, [first], RAVI, past.sequence),
      );
      expect(fieldsOf(refusal)?.round?.join(" ")).toContain("closed at");
    })();
  });

  it("makes a completed round view-only on every reviewer path, not only on assignment", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI],
    });
    const [assignment] = await service.assign(organizer, eventId, [first], RAVI, round.sequence);
    const assignmentId = assignment?.id as string;
    await service.updateRound(organizer, eventId, round.sequence, {
      name: "First pass",
      state: "closed",
      anonymized: true,
      poolMode: "named",
    });

    /*
     * Four write paths, one rule.
     *
     * "Preserve immutable completed-round history" is only as strong as its weakest path, and a
     * round that refuses assignments while still accepting evaluations is a round whose closure
     * means nothing. Each of these used to be reachable.
     */
    for (const [name, work] of [
      [
        "saving scores",
        service.saveEvaluation(
          ravi,
          eventId,
          assignmentId,
          { scores: [{ criterionId: "fit", value: 4 }], notes: "", complete: false },
          "correlation",
        ),
      ],
      ["declaring a conflict", service.declareConflict(ravi, eventId, assignmentId, "A reason")],
      ["assigning more work", service.assign(organizer, eventId, [second], RAVI, round.sequence)],
    ] as const) {
      const refusal = await refusalOf(work);
      expect(refusal, `${name} was not refused`).toBeInstanceOf(ReviewValidationError);
      expect(
        Object.values(fieldsOf(refusal) ?? {})
          .flat()
          .join(" "),
      ).toContain("is closed");
    }

    // And it is still *readable*: the queue answers, carrying the reason rather than an error.
    const queue = await service.reviewerQueue(ravi, eventId);
    expect(queue[0]?.roundClosedReason).toContain("is closed");
    expect(queue[0]?.assignment.id).toBe(assignmentId);
  });

  it("projects the author by the round's policy, and never to the assistant", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const blind = await service.createRound(organizer, eventId, {
      name: "Blind pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI],
    });
    const open = await service.createRound(organizer, eventId, {
      name: "Open pass",
      state: "open",
      anonymized: false,
      reviewerIds: [NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, blind.sequence);
    await service.assign(organizer, eventId, [first], NINA, open.sequence);

    const blindItem = (await service.reviewerQueue(ravi, eventId))[0];
    const openItem = (await service.reviewerQueue(nina, eventId))[0];

    /*
     * The same abstract, two reviewers, genuinely different bytes.
     *
     * Asserted over what serializes rather than over a flag, the way `ACC-REVIEW` asserts blind
     * review everywhere else: a masked projection that still carried the name in some field would
     * pass a test that only checked `anonymized`.
     */
    const blindText = JSON.stringify(blindItem?.proposal);
    expect(blindText).not.toContain("Robin Submitter");
    expect(blindText).not.toContain("robin@example.test");
    // Co-authors are absent rather than masked: a masked list still leaks its length.
    expect(blindText).not.toContain("Avery Chen");
    expect(blindItem?.proposal.coAuthors).toEqual([]);

    expect(openItem?.proposal.submitterName).toBe("Robin Submitter");
    expect(openItem?.proposal.coAuthors).toEqual([{ name: "Avery Chen", role: "Co-presenter" }]);
    // Open authorship is not an organizer projection: the contact address is organizer-only in
    // every round, and the owning account id is on no reviewer response at all.
    expect(openItem?.proposal.submitter).toBeNull();
    expect(JSON.stringify(openItem?.proposal)).not.toContain("submitterUserId");
  });

  it("shows an organizer both reviewers' submitted work, and each reviewer only their own", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI, NINA],
    });
    const [raviAssignment] = await service.assign(
      organizer,
      eventId,
      [first],
      RAVI,
      round.sequence,
    );
    const [ninaAssignment] = await service.assign(
      organizer,
      eventId,
      [first],
      NINA,
      round.sequence,
    );
    // One completes, one leaves a draft — the two states the organizer's detail treats differently.
    await service.saveEvaluation(
      ravi,
      eventId,
      raviAssignment?.id as string,
      {
        scores: [{ criterionId: "fit", value: 4 }],
        notes: "Exactly the comment #221 says an organizer could not see.",
        complete: true,
      },
      "correlation",
    );
    await service.saveEvaluation(
      nina,
      eventId,
      ninaAssignment?.id as string,
      {
        scores: [{ criterionId: "fit", value: 2 }],
        notes: "Still thinking about this one.",
        complete: false,
      },
      "correlation",
    );

    /*
     * #221's outcome: the organizer's projection carries the exact rating **and** the written
     * comment, not just the aggregate and the completion count.
     */
    const workspace = await service.organizerWorkspace(organizer, eventId);
    const completed = (workspace.evaluations ?? []).find(
      (item) => item.assignmentId === raviAssignment?.id,
    );
    expect(completed).toMatchObject({
      state: "completed",
      reviewerId: RAVI,
      notes: "Exactly the comment #221 says an organizer could not see.",
    });
    expect(completed?.scores).toEqual([{ criterionId: "fit", value: 4, score: 4 }]);

    /*
     * And the boundary that must hold while it does: neither reviewer's queue contains the other's
     * evaluation, draft or completed. Asserted over the serialized response rather than over a
     * field, because the failure this guards against is a comment travelling in a shape nobody
     * looked for.
     */
    for (const [reviewer, own, theirs] of [
      [ravi, "Exactly the comment", "Still thinking"],
      [nina, "Still thinking", "Exactly the comment"],
    ] as const) {
      const queue = JSON.stringify(await service.reviewerQueue(reviewer, eventId));
      expect(queue).toContain(own);
      expect(queue).not.toContain(theirs);
    }
  });

  it("validates and weighs scores against the round's own scorecard", async () => {
    const { service, repository } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const committee = await service.createRound(organizer, eventId, {
      name: "Programme committee",
      state: "open",
      anonymized: true,
      criteria: [...COMMITTEE],
      reviewerIds: [NINA],
    });
    const [assignment] = await service.assign(
      organizer,
      eventId,
      [first],
      NINA,
      committee.sequence,
    );
    const assignmentId = assignment?.id as string;

    // The queue offers the round's rubric, not the event plan's.
    const item = (await service.reviewerQueue(nina, eventId))[0];
    expect(item?.plan?.criteria.map(({ id }) => id)).toEqual(["programme_fit", "delivery"]);

    // A score against the *event* plan's criterion is refused: it names a criterion this round's
    // form never showed.
    const refusal = await refusalOf(
      service.saveEvaluation(
        nina,
        eventId,
        assignmentId,
        { scores: [{ criterionId: "fit", value: 4 }], notes: "", complete: true },
        "correlation",
      ),
    );
    expect(refusal).toBeInstanceOf(ReviewValidationError);

    await service.saveEvaluation(
      nina,
      eventId,
      assignmentId,
      {
        scores: [
          { criterionId: "programme_fit", value: 5 },
          { criterionId: "delivery", value: 3 },
        ],
        notes: "The strongest opener we have.",
        complete: true,
      },
      "correlation",
    );
    // (5 × 3 + 3 × 1) / 4 = 4.5 — and an unweighted mean of 5 and 3 is 4.0, so this number is
    // only reachable if the round's own weights were the ones applied.
    const outcomes = await repository.listOutcomes(eventId);
    expect(outcomes).toMatchObject([
      { proposalId: first, round: committee.sequence, averageScore: 4.5 },
    ]);
  });

  it("reminds each outstanding reviewer once per round, and says what happened to each", async () => {
    const { service, reminded } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI, NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, round.sequence);
    const [ninaAssignment] = await service.assign(
      organizer,
      eventId,
      [second],
      NINA,
      round.sequence,
    );
    await service.saveEvaluation(
      nina,
      eventId,
      ninaAssignment?.id as string,
      { scores: [{ criterionId: "fit", value: 4 }], notes: "", complete: true },
      "correlation",
    );

    const first_ = await service.remindOutstandingReviewers(organizer, eventId, round.sequence, [
      RAVI,
      NINA,
    ]);
    /*
     * Nina finished between the organizer's page load and the click, so she is reported as
     * `nothing_outstanding` and **no message is sent to her at all**. Telling somebody to finish
     * work they have already finished is the failure this recomputation exists to avoid; the count
     * comes from storage rather than from the request, which is a snapshot of a screen.
     */
    expect(first_).toEqual([
      { reviewerId: NINA, outstanding: 0, state: "nothing_outstanding" },
      { reviewerId: RAVI, outstanding: 1, state: "queued" },
    ]);
    expect(reminded).toHaveLength(1);

    // Pressing again queues nothing and says so, which is the difference between "sent" and
    // "sent again" that an organizer needs in order not to press a third time.
    const again = await service.remindOutstandingReviewers(organizer, eventId, round.sequence, [
      RAVI,
    ]);
    expect(again).toEqual([{ reviewerId: RAVI, outstanding: 1, state: "already_sent" }]);
  });

  it("refuses a reminder for a reviewer with no work in that round, and a round that is not there", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI, NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, round.sequence);
    const refusal = await refusalOf(
      service.remindOutstandingReviewers(organizer, eventId, round.sequence, [NINA]),
    );
    expect(fieldsOf(refusal)?.reviewerIds?.join(" ")).toContain("no assignments in “First pass”");
    await expect(
      service.remindOutstandingReviewers(organizer, eventId, 99, [RAVI]),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);
  });

  it("refuses every round operation to a reviewer, and to nobody", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: true,
      reviewerIds: [RAVI],
    });
    /*
     * Rounds are staffing and policy, so `review:evaluate` reaches none of it. Driven for each
     * method rather than for one, because an authorization check is per method and a suite that
     * proves one is proving one.
     */
    const terms = {
      name: "First pass",
      state: "open" as const,
      anonymized: true,
      poolMode: "named" as const,
    };
    for (const [name, work] of [
      ["listRounds", service.listRounds(ravi, eventId)],
      [
        "createRound",
        service.createRound(ravi, eventId, { name: "Sneaky", anonymized: true, poolMode: "named" }),
      ],
      ["updateRound", service.updateRound(ravi, eventId, round.sequence, terms)],
      ["setRoundPool", service.setRoundPool(ravi, eventId, round.sequence, [RAVI])],
      [
        "remindOutstandingReviewers",
        service.remindOutstandingReviewers(ravi, eventId, round.sequence, [RAVI]),
      ],
    ] as const) {
      await expect(work, `${name} was not refused`).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    // An anonymous caller is told to authenticate rather than that they lack a capability, which
    // is a different fact and a different remedy.
    await expect(service.listRounds(null, eventId)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    // Cross-event reads answer the same way an unknown event does, so a round list cannot be used
    // to probe which events exist (`ARC-AUTH-001`).
    await expect(
      service.listRounds(organizer, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("keeps an organizer out of a pool, and a stranger out of the event's", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    // The seeded organizer also holds the reviewer role on this event, which is exactly how she
    // came to be offered as a reviewer of it. A pool is who may be *given* work, and the organizer
    // console has no reviewer queue to open it in.
    const own = await refusalOf(
      service.createRound(organizer, eventId, {
        name: "Mine",
        anonymized: true,
        poolMode: "named",
        reviewerIds: [organizer.id],
      }),
    );
    expect(fieldsOf(own)?.reviewerIds?.join(" ")).toContain("your own event");
    const stranger = await refusalOf(
      service.createRound(organizer, eventId, {
        name: "Theirs",
        anonymized: true,
        poolMode: "named",
        reviewerIds: ["somebody-else"],
      }),
    );
    expect(fieldsOf(stranger)?.reviewerIds?.join(" ")).toContain("staffed on this event");
  });

  it("refuses a duplicate round name and a window that ends before it starts", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    await service.createRound(organizer, eventId, {
      name: "First pass",
      anonymized: true,
      poolMode: "named",
    });
    const duplicate = await refusalOf(
      service.createRound(organizer, eventId, {
        name: "First pass",
        anonymized: true,
        poolMode: "named",
      }),
    );
    // Two rounds with one name is a way to assign work to the wrong one.
    expect(fieldsOf(duplicate)?.name?.join(" ")).toContain("already exists");
    const backwards = await refusalOf(
      service.createRound(organizer, eventId, {
        name: "Backwards",
        anonymized: true,
        poolMode: "named",
        opensAt: "2026-09-01T00:00:00.000Z",
        closesAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(fieldsOf(backwards)?.closesAt?.join(" ")).toContain("close after it opens");
  });

  it("advances into a new round whose pool is exactly who the advance distributes to", async () => {
    const { service } = build();
    await service.configurePlan(organizer, eventId, [...PLAN]);
    const round = await service.createRound(organizer, eventId, {
      name: "First pass",
      state: "open",
      anonymized: false,
      reviewerIds: [RAVI, NINA],
    });
    await service.assign(organizer, eventId, [first], RAVI, round.sequence);
    await service.bulkTransition(organizer, eventId, [first], "under_review");

    const advanced = await service.advanceRound(
      organizer,
      eventId,
      "under_review",
      [NINA],
      5,
      round.sequence,
    );
    const rounds = await service.listRounds(organizer, eventId);
    const created = rounds.find(({ sequence }) => sequence === advanced.round);
    /*
     * The pool does **not** inherit — a second pass is usually not the same people — but the
     * anonymization policy does. Inheriting blindness is the safer default of the two: a round
     * that silently stopped being blind would expose authors to reviewers with every reason to
     * assume they are still reading blind.
     */
    expect(created).toMatchObject({ poolMode: "named", reviewerIds: [NINA], anonymized: false });
    expect(created?.reviewerIds).not.toContain(RAVI);
  });
});
