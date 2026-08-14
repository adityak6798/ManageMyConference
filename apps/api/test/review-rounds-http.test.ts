// @acceptance ACC-REVIEW
/*
 * The round, pool and reminder routes over HTTP.
 *
 * Separate from `review-http.test.ts` because these need two reviewers and a communications
 * binding, and folding both into that file's fixture would change what every existing test in it
 * is driving. What is proved here is what only the transport can be wrong about: the capability a
 * route demands, the status it answers with, and the shape it puts on the wire.
 *
 * @spec PRD-REV-001 PRD-COM-001 ARC-AUTH-001
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { EventService } from "../src/application/events/event-service";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  type ReviewNotificationPort,
  ReviewService,
} from "../src/application/review/review-service";
import { createHttpApp } from "../src/transport/http/app";

const secret = "review-rounds-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const RAVI = "seed-reviewer";
const NINA = "review-nina-alvarez";

const cookie = async (persona: "organizer" | "reviewer") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});

const build = () => {
  let id = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const reminded: Parameters<ReviewNotificationPort["remindOutstanding"]>[0][] = [];
  const reviewers = [
    { id: RAVI, name: "Ravi Reviewer" },
    { id: NINA, name: "Nina Alvarez" },
  ];
  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals: new MemorySubmittedProposalAdapter([
      {
        id: proposalId,
        eventId,
        title: "Proposal",
        abstract: "Abstract",
        submitterName: "Robin Submitter",
        submitterUserId: null,
        submitter: { name: "Robin Submitter", email: "robin@example.test" },
        answers: [],
        status: "submitted",
      },
    ]),
    notifications: {
      // Not what these suites are about; the assignment and decision notices have their
      // own coverage in `review-service.test.ts`.
      async reviewerAssigned() {
        return;
      },
      async decisionRecorded() {
        return;
      },
      async remindOutstanding(fact) {
        const repeat = reminded.some(
          (earlier) => earlier.reviewerId === fact.reviewerId && earlier.round === fact.round,
        );
        reminded.push(fact);
        return repeat ? "already_sent" : "queued";
      },
    },
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
    newId: ids,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  const app = createHttpApp(
    new EventService({
      repository: new MemoryEventRepository(),
      newId: ids,
      now: () => new Date(),
    }),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    review,
  );
  return { app, reminded };
};

const plan = {
  criteria: [{ id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 }],
};

describe("review round HTTP API", () => {
  it("creates, lists, edits and re-pools a round, allocating the sequence itself", async () => {
    const { app } = build();
    const headers = await cookie("organizer");
    await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers,
      body: JSON.stringify(plan),
    });

    const created = await app.request(`/api/events/${eventId}/review/round-plans`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Programme committee",
        anonymized: false,
        poolMode: "named",
        state: "open",
        reviewerIds: [NINA],
        opensAt: "2026-08-09T00:00:00.000Z",
        closesAt: "2026-12-01T00:00:00.000Z",
      }),
    });
    // `201`, because a round is a thing that now exists rather than a computed view — and the
    // sequence in the body is the server's, never the client's.
    expect(created.status).toBe(201);
    const { round } = (await created.json()) as { round: Record<string, unknown> };
    expect(round).toMatchObject({
      sequence: 2,
      name: "Programme committee",
      anonymized: false,
      poolMode: "named",
      reviewerIds: [NINA],
      opensAt: "2026-08-09T00:00:00.000Z",
    });

    const listed = await app.request(`/api/events/${eventId}/review/round-plans`, { headers });
    expect(listed.status).toBe(200);
    // The default `Round 1` is there too: an event that never configured one is answered with it
    // rather than with an empty list, which is the compatibility contract.
    expect(
      ((await listed.json()) as { rounds: { name: string }[] }).rounds.map((r) => r.name),
    ).toEqual(["Round 1", "Programme committee"]);

    const edited = await app.request(`/api/events/${eventId}/review/round-plans/2`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Programme committee",
        anonymized: true,
        poolMode: "named",
        state: "closed",
      }),
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()) as { round: { state: string } }).toMatchObject({
      round: { state: "closed", anonymized: true },
    });

    const pooled = await app.request(`/api/events/${eventId}/review/round-plans/2/pool`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ reviewerIds: [NINA, RAVI] }),
    });
    expect(pooled.status).toBe(200);
    expect(
      ((await pooled.json()) as { round: { reviewerIds: string[] } }).round.reviewerIds,
    ).toEqual([NINA, RAVI]);
  });

  it("refuses every round route to a reviewer and to an anonymous caller", async () => {
    const { app } = build();
    const organizer = await cookie("organizer");
    const reviewer = await cookie("reviewer");
    await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers: organizer,
      body: JSON.stringify(plan),
    });
    const body = JSON.stringify({ name: "Sneaky", anonymized: true, poolMode: "named" });
    /*
     * Rounds are staffing and policy, so `review:evaluate` reaches none of them. Each route is
     * driven rather than one standing in for the rest: an authorization check lives on a route,
     * and a suite that proves one route proves one route.
     */
    for (const [method, path, payload] of [
      ["GET", "/review/round-plans", undefined],
      ["POST", "/review/round-plans", body],
      [
        "PUT",
        "/review/round-plans/1",
        JSON.stringify({ name: "x", anonymized: true, poolMode: "named", state: "open" }),
      ],
      ["PUT", "/review/round-plans/1/pool", JSON.stringify({ reviewerIds: [] })],
      ["POST", "/review/reminders", JSON.stringify({ round: 1, reviewerIds: [RAVI] })],
    ] as const) {
      const denied = await app.request(`/api/events/${eventId}${path}`, {
        method,
        headers: reviewer,
        ...(payload ? { body: payload } : {}),
      });
      expect(denied.status, `${method} ${path} was not refused for a reviewer`).toBe(403);
      const anonymous = await app.request(`/api/events/${eventId}${path}`, {
        method,
        ...(payload ? { body: payload, headers: { "content-type": "application/json" } } : {}),
      });
      expect(anonymous.status, `${method} ${path} was not refused anonymously`).toBe(401);
    }
  });

  it("reports a reminder per reviewer, and answers 200 because a repeat creates nothing", async () => {
    const { app, reminded } = build();
    const headers = await cookie("organizer");
    await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers,
      body: JSON.stringify(plan),
    });
    await app.request(`/api/events/${eventId}/review/assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ proposalIds: [proposalId], reviewerId: RAVI }),
    });

    const sent = await app.request(`/api/events/${eventId}/review/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ round: 1, reviewerIds: [RAVI] }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({
      reminders: [{ reviewerId: RAVI, outstanding: 1, state: "queued" }],
    });

    const again = await app.request(`/api/events/${eventId}/review/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ round: 1, reviewerIds: [RAVI] }),
    });
    // Still 200 and still one delivery: the second request is a truthful report that nothing new
    // was written, not a failure and not a second message.
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      reminders: [{ reviewerId: RAVI, outstanding: 1, state: "already_sent" }],
    });
    expect(reminded).toHaveLength(2);
  });

  it("answers 404 for a round that does not exist and 400 for a malformed one", async () => {
    const { app } = build();
    const headers = await cookie("organizer");
    await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers,
      body: JSON.stringify(plan),
    });
    expect(
      (
        await app.request(`/api/events/${eventId}/review/round-plans/9`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: "Nope",
            anonymized: true,
            poolMode: "named",
            state: "open",
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/events/${eventId}/review/reminders`, {
          method: "POST",
          headers,
          body: JSON.stringify({ round: 9, reviewerIds: [RAVI] }),
        })
      ).status,
    ).toBe(404);
    // A sequence that is not a positive integer never reaches the service.
    expect(
      (
        await app.request(`/api/events/${eventId}/review/round-plans/nope/pool`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ reviewerIds: [] }),
        })
      ).status,
    ).toBe(400);
    // A rubric with no numeric criterion would divide an aggregate by zero, so it is a 400 at the
    // boundary rather than a coherence failure deeper in.
    expect(
      (
        await app.request(`/api/events/${eventId}/review/round-plans`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "No numbers",
            anonymized: true,
            poolMode: "named",
            criteria: [{ id: "note", name: "Note", description: "", type: "text", maxLength: 100 }],
          }),
        })
      ).status,
    ).toBe(400);
  });

  it("puts the round, its policy and its closure reason on the reviewer's queue", async () => {
    const { app } = build();
    const organizer = await cookie("organizer");
    const reviewer = await cookie("reviewer");
    await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers: organizer,
      body: JSON.stringify(plan),
    });
    await app.request(`/api/events/${eventId}/review/assignments`, {
      method: "POST",
      headers: organizer,
      body: JSON.stringify({ proposalIds: [proposalId], reviewerId: RAVI }),
    });
    const open = (await (
      await app.request(`/api/events/${eventId}/review/assignments`, { headers: reviewer })
    ).json()) as { assignments: { round: { name: string }; roundClosedReason: string | null }[] };
    expect(open.assignments[0]?.round).toMatchObject({ name: "Round 1", anonymized: true });
    expect(open.assignments[0]?.roundClosedReason).toBeNull();

    await app.request(`/api/events/${eventId}/review/round-plans/1`, {
      method: "PUT",
      headers: organizer,
      body: JSON.stringify({
        name: "Round 1",
        anonymized: true,
        poolMode: "event",
        state: "closed",
      }),
    });
    const closed = (await (
      await app.request(`/api/events/${eventId}/review/assignments`, { headers: reviewer })
    ).json()) as { assignments: { roundClosedReason: string | null }[] };
    // Still readable, and now carrying the reason — so the surface can say the round is shut
    // before the reviewer fills in a form whose save would be refused.
    expect(closed.assignments[0]?.roundClosedReason).toContain("is closed");
  });
});
