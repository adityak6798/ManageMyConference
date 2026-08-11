// @acceptance ACC-REVIEW
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { ReviewService } from "../src/application/review/review-service";
import { createHttpApp } from "../src/transport/http/app";

const secret = "review-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const proposalId = "10000000-0000-4000-8000-000000000001";
const cookie = async (persona: "organizer" | "reviewer" | "speaker") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});
const build = () => {
  let id = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals: new MemorySubmittedProposalAdapter([
      {
        id: proposalId,
        eventId,
        title: "Proposal",
        abstract: "Abstract",
        submitterName: "Applicant",
        answers: [],
        status: "submitted",
      },
    ]),
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
  return createHttpApp(
    events,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    review,
  );
};

describe("review HTTP API", () => {
  it("enforces organizer/reviewer roles and hides organizer aggregates", async () => {
    const app = build();
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
    expect(await workspace.json()).toMatchObject({ proposals: [{ id: proposalId }], outcomes: [] });
  });

  it("validates a plan and returns an explicitly atomic bulk contract", async () => {
    const app = build();
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

  it("returns validation feedback for an unconfigured transition status", async () => {
    const response = await build().request(`/api/events/${eventId}/review/transitions`, {
      method: "POST",
      headers: await cookie("organizer"),
      body: JSON.stringify({ proposalIds: [proposalId], toStatus: "not_configured" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { toStatus: [expect.any(String)] } },
    });
  });
});
