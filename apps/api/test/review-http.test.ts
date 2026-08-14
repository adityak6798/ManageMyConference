// @acceptance ACC-REVIEW
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { DeterministicSuggestionProvider } from "../src/adapters/suggestions/deterministic-suggestion-provider";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { ContentService } from "../src/application/content/content-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { ProposalSubmitterUnavailableError } from "../src/application/review/public";
import { ReviewService } from "../src/application/review/review-service";
import type { ReviewSuggestionPort } from "../src/application/review/suggestion-port";
import { createHttpApp } from "../src/transport/http/app";

const secret = "review-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const noContactProposalId = "10000000-0000-4000-8000-000000000002";
const cookie = async (persona: "organizer" | "reviewer" | "speaker") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});
/**
 * The review HTTP surface with the content service composed beside it.
 *
 * `acceptanceFailures` makes the content half refuse its first N calls with the domain's own
 * typed error, which is how the partial-state and retry behaviour is exercised without reaching
 * into storage.
 */
const build = ({
  acceptanceFailures = 0,
  acceptanceError,
  suggestions,
}: {
  acceptanceFailures?: number;
  acceptanceError?: Error;
  /**
   * The AI suggestion port. Omitted means the fixture; `null` means the deployment has switched
   * the assistant off, which is a state the routes have to answer for rather than crash on.
   */
  suggestions?: ReviewSuggestionPort | null;
} = {}) => {
  let id = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const proposals = new MemorySubmittedProposalAdapter([
    {
      id: proposalId,
      eventId,
      title: "Proposal",
      abstract: "Abstract",
      submitterName: "Robin Submitter",
      submitter: { name: "Robin Submitter", email: "robin@example.test" },
      answers: [],
      status: "submitted",
    },
    {
      id: noContactProposalId,
      eventId,
      title: "Proposal without a contact address",
      abstract: "The published form never asked for an email.",
      submitterName: "Applicant",
      submitter: null,
      answers: [],
      status: "submitted",
    },
  ]);
  const suggestionPort =
    suggestions === undefined ? new DeterministicSuggestionProvider() : suggestions;
  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals,
    ...(suggestionPort ? { suggestions: suggestionPort } : {}),
    suggestionTimeoutMs: 50,
    identities: {
      isReviewerForEvent: async (userId, scopedEventId) =>
        userId === "seed-reviewer" && scopedEventId === eventId,
      listReviewersForEvent: async (scopedEventId) =>
        scopedEventId === eventId ? [{ id: "seed-reviewer", name: "Ravi Reviewer" }] : [],
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
  const events = new EventService({
    repository: new MemoryEventRepository(),
    newId: ids,
    now: () => new Date(),
  });
  const contentRepository = new MemoryContentRepository({
    sessions: [],
    speakers: [],
    tasks: [],
    assets: [],
    messages: [],
  });
  let remainingFailures = acceptanceFailures;
  class ComposedContentService extends ContentService {
    // `acceptSession` rather than `accept`, because that is the seam the composed decision route
    // calls: the two differ only in whether the event's whole content workspace is projected
    // afterwards, and this route reads one session id (issue #207).
    override async acceptSession(...args: Parameters<ContentService["acceptSession"]>) {
      if (remainingFailures-- > 0)
        throw acceptanceError ?? new ProposalSubmitterUnavailableError("Simulated content refusal");
      return super.acceptSession(...args);
    }
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createHttpApp(
    events,
    logger,
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    review,
    undefined,
    // Acceptance is composed in transport, so the review routes only work end to end with the
    // content service wired in beside them.
    new ComposedContentService({
      repository: contentRepository,
      assetStorage: new DeterministicAssetStorage(),
      proposals: review,
      agenda: new AgendaService(
        new MemoryAgendaRepository(),
        () => new Date("2026-08-10T12:00:00.000Z"),
        new FixtureSchedulableContentQuery(new Map()),
      ),
      speakerConversion: new MemorySpeakerConversion(contentRepository, ids),
      newId: ids,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }),
  );
  // `proposals` is exposed so a test can seed a status set that predates the reserved decision
  // statuses — the state the HTTP surface has to reconcile.
  return { app, proposals, logger };
};

/** The decisions the organizer board currently shows, which is where a partial state surfaces. */
const workspaceDecisions = async (
  app: ReturnType<typeof build>["app"],
  headers: Record<string, string>,
) =>
  (
    (await (await app.request(`/api/events/${eventId}/review/organizer`, { headers })).json()) as {
      decisions: unknown[];
    }
  ).decisions;

describe("review HTTP API", () => {
  it("enforces organizer/reviewer roles and hides organizer aggregates", async () => {
    const { app } = build();
    expect((await app.request(`/api/events/${eventId}/review/organizer`)).status).toBe(401);
    expect(
      (
        await app.request(`/api/events/${eventId}/review/organizer`, {
          headers: await cookie("reviewer"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/events/${eventId}/review/assignments`, {
          headers: await cookie("organizer"),
        })
      ).status,
    ).toBe(403);
    const workspace = await app.request(`/api/events/${eventId}/review/organizer`, {
      headers: await cookie("organizer"),
    });
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      proposals: [{ id: proposalId }, { id: noContactProposalId }],
      outcomes: [],
    });
    const malformed = { method: "PUT", body: "{", headers: { "content-type": "application/json" } };
    expect((await app.request(`/api/events/${eventId}/review/plan`, malformed)).status).toBe(401);
    expect(
      (
        await app.request(`/api/events/${eventId}/review/plan`, {
          ...malformed,
          headers: await cookie("reviewer"),
        })
      ).status,
    ).toBe(403);
  });

  it("validates a plan and returns an explicitly atomic bulk contract", async () => {
    const { app } = build();
    const headers = await cookie("organizer");
    const plan = await app.request(`/api/events/${eventId}/review/plan`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        criteria: [{ id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 }],
      }),
    });
    expect(plan.status).toBe(200);
    const transition = await app.request(`/api/events/${eventId}/review/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ proposalIds: [proposalId], toStatus: "under_review" }),
    });
    expect(transition.status).toBe(200);
    expect(await transition.json()).toMatchObject({
      mode: "atomic",
      proposals: [{ status: "under_review" }],
    });
  });

  it("records a decision, exposes it to organizers, and keeps it organizer-only", async () => {
    const { app } = build();
    const headers = await cookie("organizer");
    const decided = await app.request(`/api/events/${eventId}/review/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        proposalIds: [proposalId],
        outcome: "accepted",
        note: "Clear yes",
      }),
    });
    expect(decided.status).toBe(201);
    await expect(decided.json()).resolves.toMatchObject({
      proposals: [{ id: proposalId, status: "accepted" }],
      decisions: [{ proposalId, outcome: "accepted", decidedBy: "seed-organizer" }],
      // The session is created by the same request; the client makes one call, not two.
      acceptances: [{ proposalId, state: "content", sessionId: expect.any(String) }],
    });
    const content = await app.request(`/api/events/${eventId}/content`, { headers });
    await expect(content.json()).resolves.toMatchObject({
      sessions: [{ proposalId, title: "Proposal", abstract: "Abstract" }],
      speakers: [{ name: "Robin Submitter", email: "robin@example.test" }],
    });
    const workspace = await app.request(`/api/events/${eventId}/review/organizer`, { headers });
    await expect(workspace.json()).resolves.toMatchObject({
      decisions: [{ proposalId, outcome: "accepted", note: "Clear yes" }],
      proposals: expect.arrayContaining([
        expect.objectContaining({
          id: proposalId,
          status: "accepted",
          submitter: { name: "Robin Submitter", email: "robin@example.test" },
        }),
      ]),
    });
    expect(
      (
        await app.request(`/api/events/${eventId}/review/decisions`, {
          method: "POST",
          headers: await cookie("reviewer"),
          body: JSON.stringify({ proposalIds: [proposalId], outcome: "declined" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/events/${eventId}/review/decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ proposalIds: [proposalId], outcome: "maybe" }),
        })
      ).status,
    ).toBe(400);
  });

  it("reports the decision as recorded when the session cannot be created", async () => {
    const { app } = build();
    const headers = await cookie("organizer");
    const decide = () =>
      app.request(`/api/events/${eventId}/review/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [noContactProposalId], outcome: "accepted" }),
      });

    const refused = await decide();
    // The decision itself succeeded, so the request did not fail — the response says which half
    // happened instead of pretending the whole thing was refused.
    expect(refused.status).toBe(201);
    await expect(refused.json()).resolves.toMatchObject({
      decisions: [{ proposalId: noContactProposalId, outcome: "accepted" }],
      acceptances: [
        {
          proposalId: noContactProposalId,
          state: "decision_only",
          sessionId: null,
          detail: expect.stringContaining("no contact address"),
          fieldErrors: { "submitter.email": [expect.any(String)] },
        },
      ],
    });
    // The decision is durable, so the board shows it and content still refuses the session.
    const workspace = await app.request(`/api/events/${eventId}/review/organizer`, { headers });
    await expect(workspace.json()).resolves.toMatchObject({
      decisions: [{ proposalId: noContactProposalId, outcome: "accepted" }],
    });
    await expect(
      (await app.request(`/api/events/${eventId}/content`, { headers })).json(),
    ).resolves.toMatchObject({ sessions: [] });

    // Re-posting the identical decision does not stack up decisions.
    expect(((await (await decide()).json()) as { decisions: unknown[] }).decisions).toHaveLength(1);
    await expect(workspaceDecisions(app, headers)).resolves.toHaveLength(1);
  });

  it("reports a decision the server is holding even when acceptance fails unexpectedly", async () => {
    // The decisions are durable before acceptance runs. Answering 500 would tell the organizer
    // the request failed while the server kept the decision — so an unexpected fault becomes a
    // truthful `decision_only` row carrying the correlation id, and is logged at error level so
    // it still reaches wherever a 500 would have.
    const { app, logger } = build({
      acceptanceFailures: 1,
      acceptanceError: new Error("d1 connection reset"),
    });
    const headers = await cookie("organizer");
    const response = await app.request(`/api/events/${eventId}/review/decisions`, {
      method: "POST",
      headers: { ...headers, "x-correlation-id": "acceptance-fault" },
      body: JSON.stringify({ proposalIds: [proposalId], outcome: "accepted" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      decisions: [{ proposalId, outcome: "accepted" }],
      acceptances: [
        {
          proposalId,
          state: "decision_only",
          sessionId: null,
          detail: "The session could not be created. Reference: acceptance-fault",
        },
      ],
    });
    // The cause is not invented as a field error the organizer could act on.
    const body = (await (
      await app.request(`/api/events/${eventId}/review/decisions`, {
        method: "POST",
        headers: { ...headers, "x-correlation-id": "acceptance-fault-2" },
        body: JSON.stringify({ proposalIds: [proposalId], outcome: "accepted" }),
      })
    ).json()) as { acceptances: { state: string }[] };
    expect(body.acceptances[0]?.state).toBe("content");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "acceptance-fault",
        proposalId,
        errorName: "Error",
        errorMessage: "d1 connection reset",
      }),
      "review.acceptance.failed",
    );
    // A typed refusal is a warning, not an error; the two must not be conflated.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("heals a decision-only acceptance when the identical decision is posted again", async () => {
    // The content step fails once and then stops failing — a transient refusal, or one the
    // organizer has since fixed. Nothing else changes, so this isolates the retry itself.
    const { app } = build({ acceptanceFailures: 1 });
    const headers = await cookie("organizer");
    const decide = () =>
      app.request(`/api/events/${eventId}/review/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [proposalId], outcome: "accepted" }),
      });

    await expect((await decide()).json()).resolves.toMatchObject({
      acceptances: [{ proposalId, state: "decision_only", sessionId: null }],
    });
    await expect(
      (await app.request(`/api/events/${eventId}/content`, { headers })).json(),
    ).resolves.toMatchObject({ sessions: [] });

    const healed = await decide();
    expect(healed.status).toBe(201);
    await expect(healed.json()).resolves.toMatchObject({
      acceptances: [{ proposalId, state: "content", sessionId: expect.any(String) }],
    });
    await expect(
      (await app.request(`/api/events/${eventId}/content`, { headers })).json(),
    ).resolves.toMatchObject({ sessions: [{ proposalId }] });
    // One decision, one session: the retry healed rather than duplicated.
    await expect(workspaceDecisions(app, headers)).resolves.toHaveLength(1);
  });

  it("advertises only statuses it will accept back, for an event that predates the reserved ones", async () => {
    const { app, proposals } = build();
    const headers = await cookie("organizer");
    // The state the reviewer reproduced: storage holds a status set with no decision statuses,
    // while the organizer projection used to synthesize them on the way out.
    await proposals.saveStatuses(eventId, [{ key: "submitted", label: "Submitted", sortOrder: 0 }]);

    const workspace = await app.request(`/api/events/${eventId}/review/organizer`, { headers });
    const advertised = ((await workspace.json()) as { statuses: { key: string }[] }).statuses.map(
      ({ key }) => key,
    );
    expect(advertised).toEqual(["submitted", "accepted", "declined"]);

    // Every pipeline status the workspace offered is a status a transition accepts. The two
    // reserved ones are reachable too, but through the decision route — see the transition
    // guard below, which is what stops a status change from faking an outcome.
    for (const toStatus of advertised.filter((key) => key === "submitted")) {
      const response = await app.request(`/api/events/${eventId}/review/transitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [proposalId], toStatus }),
      });
      expect(response.status, `${toStatus} was advertised but refused`).toBe(200);
    }
    for (const outcome of ["accepted", "declined"]) {
      const response = await app.request(`/api/events/${eventId}/review/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [proposalId], outcome }),
      });
      expect(response.status, `${outcome} was advertised but could not be recorded`).toBe(201);
    }
    // And it was persisted, not projected: the stored set now carries them too.
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toEqual(advertised);
  });

  it("completes rather than refuses a status set that leaves out the reserved decision statuses", async () => {
    const { app, proposals } = build();
    const headers = await cookie("organizer");
    // Exactly the body `apps/web/e2e/review-workflow.spec.ts` PUTs and asserts `.ok()` on.
    const response = await app.request(`/api/events/${eventId}/review/statuses`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        statuses: [
          { key: "submitted", label: "Submitted", sortOrder: 0 },
          { key: "under_review", label: "Under review", sortOrder: 1 },
          { key: "reviewed", label: "Reviewed", sortOrder: 2 },
          { key: "withdrawn", label: "Withdrawn", sortOrder: 3 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      statuses: [
        { key: "submitted" },
        { key: "under_review" },
        { key: "reviewed" },
        { key: "withdrawn" },
        { key: "accepted", label: "Accepted" },
        { key: "declined", label: "Declined" },
      ],
    });
    expect((await proposals.listStatuses(eventId)).map(({ key }) => key)).toContain("accepted");

    // A relabelled reserved status keeps the organizer's label rather than being reset.
    const relabelled = await app.request(`/api/events/${eventId}/review/statuses`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        statuses: [
          { key: "submitted", label: "Submitted", sortOrder: 0 },
          { key: "accepted", label: "In the programme", sortOrder: 1 },
        ],
      }),
    });
    expect(relabelled.status).toBe(200);
    await expect(relabelled.json()).resolves.toMatchObject({
      statuses: [
        { key: "submitted" },
        { key: "accepted", label: "In the programme" },
        { key: "declined", label: "Declined" },
      ],
    });
  });

  it("returns validation feedback for an unconfigured transition status", async () => {
    const response = await build().app.request(`/api/events/${eventId}/review/transitions`, {
      method: "POST",
      headers: await cookie("organizer"),
      body: JSON.stringify({ proposalIds: [proposalId], toStatus: "not_configured" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { toStatus: [expect.any(String)] } },
    });
  });

  /*
   * `POST /review/transitions {toStatus:"accepted"}` answered 200 and wrote the decisionless
   * status the blocker was about. The triage select stopped offering it, but a dropdown is not
   * a rule: the board still turned green with no decision behind it, so the content domain
   * refused the abstract its own board showed as accepted. This is the rule.
   */
  it("refuses a transition into a reserved decision status over HTTP and names the decisions route", async () => {
    const { app } = build();
    const headers = await cookie("organizer");

    for (const toStatus of ["accepted", "declined"]) {
      const response = await app.request(`/api/events/${eventId}/review/transitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [proposalId], toStatus }),
      });
      expect(response.status, toStatus).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; fieldErrors?: Record<string, string[]> };
      };
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.fieldErrors?.toStatus?.join(" "), toStatus).toContain(
        `/api/events/${eventId}/review/decisions`,
      );
    }

    // The half-state the blocker described never happened: no status change, no decision.
    const workspace = (await (
      await app.request(`/api/events/${eventId}/review/organizer`, { headers })
    ).json()) as { proposals: { id: string; status: string }[]; decisions: unknown[] };
    expect(workspace.proposals.find(({ id }) => id === proposalId)?.status).toBe("submitted");
    expect(workspace.decisions).toEqual([]);

    // And the route the refusal names produces the whole outcome, session included.
    const decided = await app.request(`/api/events/${eventId}/review/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ proposalIds: [proposalId], outcome: "accepted" }),
    });
    expect(decided.status).toBe(201);
    await expect(decided.json()).resolves.toMatchObject({
      decisions: [{ proposalId, outcome: "accepted" }],
      acceptances: [{ proposalId, state: "content" }],
    });
  });

  /**
   * A mis-assignment used to be permanent, and the same click froze the rubric for good. The
   * route that undoes it, and the one state it refuses.
   */
  describe("removing a review assignment", () => {
    const assign = async (
      app: ReturnType<typeof build>["app"],
      headers: Record<string, string>,
    ) => {
      await app.request(`/api/events/${eventId}/review/plan`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          criteria: [{ id: "fit", name: "Fit", description: "", minScore: 1, maxScore: 5 }],
        }),
      });
      const created = await app.request(`/api/events/${eventId}/review/assignments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalIds: [proposalId], reviewerId: "seed-reviewer" }),
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { assignments: { id: string }[] }).assignments[0]
        ?.id as string;
    };

    it("removes it for an organizer, and the reviewer's queue loses it", async () => {
      const { app } = build();
      const headers = await cookie("organizer");
      const assignmentId = await assign(app, headers);

      const removed = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}`,
        { method: "DELETE", headers },
      );
      expect(removed.status).toBe(200);
      // The removed assignment is echoed back so the caller can name it in what it announces.
      await expect(removed.json()).resolves.toMatchObject({
        assignment: { id: assignmentId, proposalId, reviewerId: "seed-reviewer" },
      });

      await expect(
        (await app.request(`/api/events/${eventId}/review/organizer`, { headers })).json(),
      ).resolves.toMatchObject({ assignments: [] });
      await expect(
        (
          await app.request(`/api/events/${eventId}/review/assignments`, {
            headers: await cookie("reviewer"),
          })
        ).json(),
      ).resolves.toMatchObject({ assignments: [] });
      // With no assignment left, the rubric the assignment locked can be edited again.
      const rewritten = await app.request(`/api/events/${eventId}/review/plan`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          criteria: [{ id: "fit", name: "Renamed", description: "", minScore: 1, maxScore: 5 }],
        }),
      });
      expect(rewritten.status).toBe(200);
    });

    it("refuses the reviewer, the anonymous caller, and an id it cannot see", async () => {
      const { app } = build();
      const headers = await cookie("organizer");
      const assignmentId = await assign(app, headers);
      const remove = (path: string, requestHeaders?: Record<string, string>) =>
        app.request(path, {
          method: "DELETE",
          ...(requestHeaders ? { headers: requestHeaders } : {}),
        });

      expect(
        (await remove(`/api/events/${eventId}/review/assignments/${assignmentId}`)).status,
      ).toBe(401);
      expect(
        (
          await remove(
            `/api/events/${eventId}/review/assignments/${assignmentId}`,
            await cookie("reviewer"),
          )
        ).status,
      ).toBe(403);
      // An unknown id and one belonging to another event are the same answer.
      expect(
        (
          await remove(
            `/api/events/${eventId}/review/assignments/00000000-0000-4000-8000-0000000000ff`,
            headers,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await remove(
            `/api/events/00000000-0000-4000-8000-000000000002/review/assignments/${assignmentId}`,
            headers,
          )
        ).status,
      ).toBe(404);
      // A malformed path is a 400, not a 404 pretending the id was checked.
      expect(
        (await remove(`/api/events/${eventId}/review/assignments/not-a-uuid`, headers)).status,
      ).toBe(400);

      // None of them removed anything.
      await expect(
        (await app.request(`/api/events/${eventId}/review/organizer`, { headers })).json(),
      ).resolves.toMatchObject({ assignments: [{ id: assignmentId }] });
    });

    it("refuses to remove an assignment the reviewer has already scored", async () => {
      const { app } = build();
      const headers = await cookie("organizer");
      const assignmentId = await assign(app, headers);
      const completed = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/evaluation`,
        {
          method: "PUT",
          headers: await cookie("reviewer"),
          body: JSON.stringify({
            scores: [{ criterionId: "fit", score: 4 }],
            notes: "",
            complete: true,
          }),
        },
      );
      expect(completed.status).toBe(200);

      const refused = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}`,
        { method: "DELETE", headers },
      );
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as {
        error: { fieldErrors?: Record<string, string[]> };
      };
      expect(body.error.fieldErrors?.assignmentId?.join(" ")).toContain(
        "already completed their evaluation",
      );
      // The score and the aggregate it feeds both survive the refusal.
      await expect(
        (await app.request(`/api/events/${eventId}/review/organizer`, { headers })).json(),
      ).resolves.toMatchObject({
        assignments: [{ id: assignmentId }],
        outcomes: [{ proposalId, completedEvaluationCount: 1, averageScore: 4 }],
      });
    });
  });
  describe("AI-assisted suggestions", () => {
    /** A plan, an under-review abstract and one assignment to the seeded reviewer. */
    const readyForReview = async (app: ReturnType<typeof build>["app"]) => {
      const organizer = await cookie("organizer");
      await app.request(`/api/events/${eventId}/review/plan`, {
        method: "PUT",
        headers: organizer,
        body: JSON.stringify({
          criteria: [
            { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 },
          ],
        }),
      });
      const created = await app.request(`/api/events/${eventId}/review/assignments`, {
        method: "POST",
        headers: organizer,
        body: JSON.stringify({ proposalIds: [proposalId], reviewerId: "seed-reviewer" }),
      });
      const { assignments } = (await created.json()) as { assignments: { id: string }[] };
      return assignments[0]?.id as string;
    };

    it("drafts, offers and accepts a suggestion without completing anything", async () => {
      const { app } = build();
      const reviewer = await cookie("reviewer");
      const assignmentId = await readyForReview(app);

      const drafted = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
        { method: "POST", headers: reviewer },
      );
      expect(drafted.status).toBe(201);
      const { suggestion } = (await drafted.json()) as {
        suggestion: { id: string; state: string; provenance: Record<string, string> };
      };
      expect(suggestion.state).toBe("offered");
      // Provenance is on the wire, not only in storage — a reviewer cannot weigh a draft whose
      // origin their client never received.
      expect(suggestion.provenance.model).toBe("fixture-suggester-v1");
      expect(suggestion.provenance.promptVersion).toBe("review-suggestion/v1");
      expect(suggestion.provenance.proposalRevision).toMatch(/^rev-/);

      const queue = await (
        await app.request(`/api/events/${eventId}/review/assignments`, { headers: reviewer })
      ).json();
      expect(queue).toMatchObject({
        suggestionsEnabled: true,
        assignments: [{ suggestions: [{ id: suggestion.id, state: "offered" }] }],
      });

      const answered = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions/${suggestion.id}/response`,
        { method: "POST", headers: reviewer, body: JSON.stringify({ response: "accepted" }) },
      );
      expect(answered.status).toBe(200);
      // A draft, attributable to the suggestion, and no aggregate on the organizer's board.
      expect(await answered.json()).toMatchObject({
        suggestion: { state: "accepted", respondedBy: "seed-reviewer" },
        evaluation: { state: "draft", source: "suggested", suggestionId: suggestion.id },
      });
      expect(
        await (
          await app.request(`/api/events/${eventId}/review/organizer`, {
            headers: await cookie("organizer"),
          })
        ).json(),
      ).toMatchObject({ outcomes: [] });
    });

    it("reports an unavailable assistant as an upstream failure the reviewer can act on", async () => {
      const { app } = build({ suggestions: new DeterministicSuggestionProvider("timeout") });
      const reviewer = await cookie("reviewer");
      const assignmentId = await readyForReview(app);

      const refused = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
        { method: "POST", headers: reviewer },
      );

      // Not an internal error: a model that timed out is neither our bug nor the reviewer's
      // mistake, and the normalized code travels without any provider text behind it.
      expect(refused.status).toBe(502);
      const body = (await refused.json()) as {
        error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
      };
      expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(body.error.message).toContain("Score this abstract yourself");
      expect(body.error.fieldErrors?.suggestion).toEqual(["PROVIDER_TIMEOUT"]);

      // The manual path still works, which is the whole degradation design.
      const saved = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/evaluation`,
        {
          method: "PUT",
          headers: reviewer,
          body: JSON.stringify({
            scores: [{ criterionId: "fit", value: 4 }],
            notes: "",
            complete: true,
          }),
        },
      );
      expect(saved.status).toBe(200);
    });

    it("answers 404 and offers nothing when the assistant is switched off", async () => {
      const { app } = build({ suggestions: null });
      const reviewer = await cookie("reviewer");
      const assignmentId = await readyForReview(app);

      const refused = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
        { method: "POST", headers: reviewer },
      );

      expect(refused.status).toBe(404);
      expect(
        await (
          await app.request(`/api/events/${eventId}/review/assignments`, { headers: reviewer })
        ).json(),
      ).toMatchObject({ suggestionsEnabled: false });
    });

    it("refuses a suggestion request from anyone but the assigned reviewer", async () => {
      const { app } = build();
      const assignmentId = await readyForReview(app);

      expect(
        (
          await app.request(
            `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
            { method: "POST" },
          )
        ).status,
      ).toBe(401);
      // An organizer holds `review:manage`, not `review:evaluate`: drafting is the reviewer's act.
      expect(
        (
          await app.request(
            `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
            { method: "POST", headers: await cookie("organizer") },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(
            `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`,
            { method: "POST", headers: await cookie("speaker") },
          )
        ).status,
      ).toBe(403);
    });

    it("refuses a second answer to the same suggestion with a conflict", async () => {
      const { app } = build();
      const reviewer = await cookie("reviewer");
      const assignmentId = await readyForReview(app);
      const { suggestion } = (await (
        await app.request(`/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`, {
          method: "POST",
          headers: reviewer,
        })
      ).json()) as { suggestion: { id: string } };
      const answer = () =>
        app.request(
          `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions/${suggestion.id}/response`,
          { method: "POST", headers: reviewer, body: JSON.stringify({ response: "rejected" }) },
        );
      expect((await answer()).status).toBe(200);

      expect((await answer()).status).toBe(409);
    });

    it("refuses a response body that says nothing about accepting or dismissing", async () => {
      const { app } = build();
      const reviewer = await cookie("reviewer");
      const assignmentId = await readyForReview(app);
      const { suggestion } = (await (
        await app.request(`/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`, {
          method: "POST",
          headers: reviewer,
        })
      ).json()) as { suggestion: { id: string } };

      const refused = await app.request(
        `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions/${suggestion.id}/response`,
        { method: "POST", headers: reviewer, body: JSON.stringify({ response: "maybe" }) },
      );

      expect(refused.status).toBe(400);
    });
  });
});
