// @acceptance ACC-SPEAKER ACC-REVIEW
import { describe, expect, it, vi } from "vitest";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import { EventService } from "../src/application/events/event-service";
import { ReviewService } from "../src/application/review/review-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";

const secret = "content-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const submittedProposalId = "10000000-0000-4000-8000-000000000001";
const noContactProposalId = "10000000-0000-4000-8000-000000000002";
const foreignProposalId = "10000000-0000-4000-8000-000000000099";
/** The seeded demo speaker, so the portal assertions below exercise a real owner. */
const samProfile = {
  id: "10000000-0000-4000-8000-00000000000a",
  eventId,
  userId: "seed-speaker",
  sourcePersonId: "crm-email:sam@example.test",
  name: "Sam Speaker",
  email: "sam@example.test",
  bio: "",
  pronouns: "",
  organization: "",
};
async function cookie(persona: "organizer" | "reviewer" | "speaker") {
  return {
    cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
    "content-type": "application/json",
  };
}
/**
 * The whole chain, in memory: proposals that came through the CFP, the review domain that can
 * decide on them, and the content service that may only act on a recorded decision.
 */
function app() {
  let id = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const repository = new MemoryContentRepository({
    sessions: [],
    speakers: [samProfile],
    tasks: [],
    assets: [],
    messages: [],
  });
  const proposals = new MemorySubmittedProposalAdapter([
    {
      id: submittedProposalId,
      eventId,
      title: "Designing the calm conference",
      abstract: "A practical guide to reducing operational noise.",
      submitterName: "Sam Speaker",
      submitter: { name: "Sam Speaker", email: "sam@example.test" },
      answers: [
        { fieldId: "format", label: "Session format", type: "select", value: "45-minute talk" },
      ],
      status: "submitted",
    },
    {
      id: noContactProposalId,
      eventId,
      title: "A proposal with no contact address",
      abstract: "The published form never asked for an email.",
      submitterName: "Applicant",
      submitter: null,
      answers: [],
      status: "submitted",
    },
    {
      id: foreignProposalId,
      eventId: "00000000-0000-4000-8000-000000000099",
      title: "Private outside proposal",
      abstract: "This proposal must never cross event boundaries.",
      submitterName: "Outside Author",
      submitter: { name: "Outside Author", email: "outside@example.test" },
      answers: [],
      status: "submitted",
    },
  ]);
  const review = new ReviewService({
    repository: new MemoryReviewRepository(),
    proposals,
    identities: {
      isReviewerForEvent: async () => true,
      listReviewersForEvent: async () => [{ id: "seed-reviewer", name: "Ravi Reviewer" }],
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
    newId,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return createHttpApp(
    new EventService({
      repository: new MemoryEventRepository(),
      newId: crypto.randomUUID,
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
    undefined,
    new ContentService({
      repository,
      assetStorage: new DeterministicAssetStorage(),
      proposals: review,
      speakerConversion: new MemorySpeakerConversion(repository, newId),
      newId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }),
  );
}
type Api = ReturnType<typeof app>;
const decide = (api: Api, headers: Record<string, string>, body: unknown) =>
  api.request(`/api/events/${eventId}/review/decisions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
const accept = (api: Api, headers: Record<string, string>, proposalId: string) =>
  api.request(`/api/events/${eventId}/content/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ proposalId }),
  });

describe("content HTTP transport", () => {
  it("only turns a proposal the review domain accepted into a session", async () => {
    const api = app();
    const headers = await cookie("organizer");

    // A fabricated id is not a proposal. Issue #65 recorded this as a 200 that created a
    // session and a ghost speaker; it is now a 4xx that creates nothing.
    const invented = await accept(api, headers, "00000000-0000-4000-8000-0000000000ff");
    expect(invented.status).toBe(404);
    await expect(invented.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });

    // A real proposal that no organizer has accepted is refused too.
    const undecided = await accept(api, headers, submittedProposalId);
    expect(undecided.status).toBe(409);
    await expect(undecided.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", fieldErrors: { proposalId: [expect.any(String)] } },
    });

    // Another event's proposal is indistinguishable from one that does not exist.
    expect((await accept(api, headers, foreignProposalId)).status).toBe(404);
    // A malformed proposal reference never reaches the domain.
    expect((await accept(api, headers, "not-a-uuid")).status).toBe(400);
    // Nothing above created anything.
    await expect(
      (await api.request(`/api/events/${eventId}/content`, { headers })).json(),
    ).resolves.toMatchObject({ sessions: [] });

    const decided = await decide(api, headers, {
      proposalIds: [submittedProposalId],
      outcome: "accepted",
      note: "Strong fit",
    });
    expect(decided.status).toBe(201);
    await expect(decided.json()).resolves.toMatchObject({
      proposals: [{ id: submittedProposalId, status: "accepted" }],
      decisions: [{ outcome: "accepted", decidedBy: "seed-organizer", note: "Strong fit" }],
    });

    // Only now does acceptance succeed, and it carries the proposal's own content.
    const accepted = await accept(api, headers, submittedProposalId);
    expect(accepted.status).toBe(201);
    const workspace = await accepted.json();
    expect(workspace.sessions).toMatchObject([
      {
        proposalId: submittedProposalId,
        title: "Designing the calm conference",
        abstract: "A practical guide to reducing operational noise.",
        format: "45-minute talk",
      },
    ]);
    expect(workspace.speakers).toMatchObject([{ name: "Sam Speaker", email: "sam@example.test" }]);
    expect(workspace.tasks).toHaveLength(2);

    // Idempotent: the same command a second time still yields exactly one session and no
    // duplicate onboarding work.
    expect((await accept(api, headers, submittedProposalId)).status).toBe(201);
    const repeated = await (
      await api.request(`/api/events/${eventId}/content`, { headers })
    ).json();
    expect(repeated.sessions).toHaveLength(1);
    expect(repeated.tasks).toHaveLength(2);

    // Accepted but unreachable: no address means no speaker identity, reported per field.
    expect(
      (await decide(api, headers, { proposalIds: [noContactProposalId], outcome: "accepted" }))
        .status,
    ).toBe(201);
    const unreachable = await accept(api, headers, noContactProposalId);
    expect(unreachable.status).toBe(400);
    await expect(unreachable.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { "submitter.email": [expect.any(String)] },
      },
    });

    // Deciding is organizer work; a reviewer cannot record one.
    expect(
      (
        await decide(api, await cookie("reviewer"), {
          proposalIds: [submittedProposalId],
          outcome: "declined",
        })
      ).status,
    ).toBe(403);
    // And acceptance stays organizer-only whatever the body is.
    expect(
      (
        await api.request(`/api/events/${eventId}/content/accept`, {
          method: "POST",
          headers: await cookie("speaker"),
          body: "{",
        })
      ).status,
    ).toBe(403);
  });

  it("returns a speaker-scoped portal and denies reviewer access", async () => {
    const api = app();
    const organizer = await cookie("organizer");
    await decide(api, organizer, { proposalIds: [submittedProposalId], outcome: "accepted" });
    expect((await accept(api, organizer, submittedProposalId)).status).toBe(201);

    const portal = await api.request(`/api/events/${eventId}/content`, {
      headers: await cookie("speaker"),
    });
    expect(portal.status).toBe(200);
    const portalBody = await portal.json();
    expect(portalBody.sessions).toHaveLength(1);
    expect(
      (await api.request(`/api/events/${eventId}/content`, { headers: await cookie("reviewer") }))
        .status,
    ).toBe(403);
    const profileId = portalBody.speakers[0]?.id;
    expect(
      (
        await api.request("/api/speaker-tasks", {
          method: "POST",
          headers: organizer,
          body: JSON.stringify({
            profileId,
            title: "Upload slides",
            dueAt: "2026-09-01T23:59:00.000Z",
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api.request("/api/speaker-messages", {
          method: "POST",
          headers: organizer,
          body: JSON.stringify({ profileId, subject: "Reminder sent" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api.request(`/api/events/${eventId}/tasks/${portalBody.tasks[0]?.id}/complete`, {
          method: "POST",
          headers: organizer,
        })
      ).status,
    ).toBe(403);

    const uploaded = await api.request("/api/speaker-assets", {
      method: "POST",
      headers: await cookie("speaker"),
      body: JSON.stringify({
        profileId,
        name: "headshot.png",
        contentType: "image/png",
        contentBase64: "AQI=",
      }),
    });
    expect(uploaded.status).toBe(201);
    const uploadedAsset = (await uploaded.json()).asset;
    expect(uploadedAsset.visibility).toBe("private");
    expect(
      (
        await api.request(`/api/speaker-assets/${uploadedAsset.id}/publish`, {
          method: "POST",
          headers: await cookie("speaker"),
        })
      ).status,
    ).toBe(403);
    // A private asset must be indistinguishable from one that does not exist, so an
    // unauthorized reader cannot enumerate asset ids (ARC-AUTH-001).
    for (const headers of [{}, await cookie("reviewer")])
      expect(
        (await api.request(`/api/speaker-assets/${uploadedAsset.id}`, { headers })).status,
      ).toBe(404);
    expect(
      (
        await api.request(`/api/speaker-assets/${uploadedAsset.id}`, {
          headers: await cookie("speaker"),
        })
      ).status,
    ).toBe(200);

    const published = await api.request(`/api/speaker-assets/${uploadedAsset.id}/publish`, {
      method: "POST",
      headers: organizer,
    });
    expect(published.status).toBe(200);
    expect((await published.json()).asset.visibility).toBe("publishable");

    // Publishing is what makes the bytes anonymously readable, and uploaded bytes are
    // never served in a way a browser will sniff or execute.
    const anonymous = await api.request(`/api/speaker-assets/${uploadedAsset.id}`);
    expect(anonymous.status).toBe(200);
    // The exact bytes that were uploaded ("AQI=" decodes to 0x01 0x02).
    expect([...new Uint8Array(await anonymous.arrayBuffer())]).toEqual([1, 2]);
    expect(anonymous.headers.get("content-type")).toBe("image/png");
    expect(anonymous.headers.get("x-content-type-options")).toBe("nosniff");
    expect(anonymous.headers.get("content-security-policy")).toContain("sandbox");
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await api.request("/api/speaker-assets/not-a-uuid")).status).toBe(400);

    const sessionId = portalBody.sessions[0]?.id;
    expect(
      (
        await api.request(`/api/content-sessions/${sessionId}`, {
          method: "PATCH",
          headers: await cookie("speaker"),
          body: "{",
        })
      ).status,
    ).toBe(403);
    const updatedSession = await api.request(`/api/content-sessions/${sessionId}`, {
      method: "PATCH",
      headers: organizer,
      body: JSON.stringify({
        title: "Managed session",
        abstract: "Managed abstract",
        format: "Workshop",
        speakerProfileIds: [profileId],
        tags: ["managed"],
        tracks: ["Studio"],
        publicationState: "ready",
      }),
    });
    expect(updatedSession.status).toBe(200);
    await expect(updatedSession.json()).resolves.toMatchObject({
      session: { title: "Managed session", publicationState: "ready" },
    });
    expect(
      (
        await api.request("/api/speaker-assets", {
          method: "POST",
          headers: await cookie("speaker"),
          body: JSON.stringify({
            profileId,
            name: "bad.png",
            contentType: "image/png",
            contentBase64: "%%%",
          }),
        })
      ).status,
    ).toBe(400);

    // RFC 5545 section 3.4 requires at least one component, so a speaker with nothing on the
    // schedule gets a 404 rather than a VCALENDAR body no calendar application will import.
    const emptyCalendar = await api.request(`/api/events/${eventId}/speaker-calendar.ics`, {
      headers: await cookie("speaker"),
    });
    expect(emptyCalendar.status).toBe(404);
    await expect(emptyCalendar.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
