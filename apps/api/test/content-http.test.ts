// @acceptance ACC-SPEAKER ACC-REVIEW
import { describe, expect, it, vi } from "vitest";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { ContentConflictError } from "../src/application/content/content-repository";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryReviewRepository } from "../src/adapters/persistence/memory-review-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { ContentService } from "../src/application/content/content-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
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
function app(
  /** Events whose public page is live; an asset is public only while its event is. */
  publishedEvents: Set<string> = new Set(),
  storage: DeterministicAssetStorage = new DeterministicAssetStorage(),
  /** The board this event starts with. A session's time comes from here and nowhere else. */
  agendaRepository: MemoryAgendaRepository = new MemoryAgendaRepository(),
  /** Supplied only by a case that needs the store to behave a particular way, such as refusing. */
  repository: MemoryContentRepository = new MemoryContentRepository({
    sessions: [],
    speakers: [samProfile],
    tasks: [],
    assets: [],
    messages: [],
  }),
) {
  let id = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const agenda = new AgendaService(
    agendaRepository,
    () => new Date("2026-08-10T12:00:00.000Z"),
    new FixtureSchedulableContentQuery(new Map()),
  );
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
      assetStorage: storage,
      proposals: review,
      agenda,
      speakerConversion: new MemorySpeakerConversion(repository, newId),
      eventPublication: { isEventPublished: async (id) => publishedEvents.has(id) },
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
    // The event's public page is live throughout, which is what lets a publishable asset be
    // read anonymously at all; the withdrawal test below varies that.
    const api = app(new Set([eventId]));
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
    // Validator-based, because publication is reversible: any lifetime at all would outlive
    // a withdrawal by exactly that much.
    expect(anonymous.headers.get("cache-control")).toBe("public, no-cache");
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

  it("routes a headshot choice to the speaker and the organizer, and refuses everyone else", async () => {
    const publishedEvents = new Set([eventId]);
    const api = app(publishedEvents);
    const organizer = await cookie("organizer");
    const speaker = await cookie("speaker");
    await decide(api, organizer, { proposalIds: [submittedProposalId], outcome: "accepted" });
    expect((await accept(api, organizer, submittedProposalId)).status).toBe(201);
    const portal = await (
      await api.request(`/api/events/${eventId}/content`, { headers: speaker })
    ).json();
    const profileId = portal.speakers[0]?.id;
    const photo = `/api/speaker-profiles/${profileId}/photo`;
    const upload = async (name: string, contentType: string) =>
      (
        await (
          await api.request("/api/speaker-assets", {
            method: "POST",
            headers: speaker,
            body: JSON.stringify({ profileId, name, contentType, contentBase64: "AQI=" }),
          })
        ).json()
      ).asset;
    const headshot = await upload("headshot.png", "image/png");
    const slides = await upload("slides.pdf", "application/pdf");
    const choose = (headers: Record<string, string>, assetId: string) =>
      api.request(photo, { method: "PUT", headers, body: JSON.stringify({ assetId }) });

    // The speaker's own action, which is the whole point of the portal.
    const chosen = await choose(speaker, headshot.id);
    expect(chosen.status).toBe(200);
    await expect(chosen.json()).resolves.toMatchObject({
      profile: { id: profileId, photoAssetId: headshot.id },
    });
    // And nothing was published by it: the file is still private, so it is still invisible.
    expect((await api.request(`/api/speaker-assets/${headshot.id}`)).status).toBe(404);
    await expect(
      (await api.request(`/api/events/${eventId}/content`, { headers: organizer })).json(),
    ).resolves.toMatchObject({ assets: expect.arrayContaining([{ ...headshot }]) });

    // A slide deck is refused with the offending field named, not with a bare 400.
    const refused = await choose(speaker, slides.id);
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { assetId: [expect.any(String)] } },
    });
    // As is a file that is not this speaker's, and a body that names no asset at all.
    expect((await choose(organizer, "00000000-0000-4000-8000-0000000000ff")).status).toBe(400);
    expect((await choose(organizer, "not-a-uuid")).status).toBe(400);
    expect(
      (await api.request(photo, { method: "PUT", headers: organizer, body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await api.request(`/api/speaker-profiles/not-a-uuid/photo`, {
          method: "PUT",
          headers: organizer,
          body: JSON.stringify({ assetId: headshot.id }),
        })
      ).status,
    ).toBe(400);

    // A reviewer may not choose one, and an anonymous caller is not even authenticated.
    expect((await choose(await cookie("reviewer"), headshot.id)).status).toBe(403);
    expect(
      (
        await api.request(photo, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assetId: headshot.id }),
        })
      ).status,
    ).toBe(401);
    expect((await api.request(photo, { method: "DELETE" })).status).toBe(401);
    expect(
      (await api.request(photo, { method: "DELETE", headers: await cookie("reviewer") })).status,
    ).toBe(403);
    // None of those refusals moved the choice.
    await expect(
      (await api.request(`/api/events/${eventId}/content`, { headers: speaker })).json(),
    ).resolves.toMatchObject({ speakers: [{ photoAssetId: headshot.id }] });

    // An organizer may set and remove it on the speaker's behalf.
    expect((await api.request(photo, { method: "DELETE", headers: organizer })).status).toBe(200);
    const cleared = await (
      await api.request(`/api/events/${eventId}/content`, { headers: speaker })
    ).json();
    expect(cleared.speakers[0]).not.toHaveProperty("photoAssetId");
    expect((await choose(organizer, headshot.id)).status).toBe(200);

    // Publishing the file is the separate decision that finally makes the face public.
    expect(
      (
        await api.request(`/api/speaker-assets/${headshot.id}/publish`, {
          method: "POST",
          headers: organizer,
        })
      ).status,
    ).toBe(200);
    expect((await api.request(`/api/speaker-assets/${headshot.id}`)).status).toBe(200);
  });

  it("withdraws published assets by unpublishing the asset, the event, or deleting it", async () => {
    const publishedEvents = new Set([eventId]);
    const storage = new DeterministicAssetStorage();
    const api = app(publishedEvents, storage);
    const organizer = await cookie("organizer");
    const speaker = await cookie("speaker");
    await decide(api, organizer, { proposalIds: [submittedProposalId], outcome: "accepted" });
    expect((await accept(api, organizer, submittedProposalId)).status).toBe(201);
    const portal = await (
      await api.request(`/api/events/${eventId}/content`, { headers: speaker })
    ).json();
    const profileId = portal.speakers[0]?.id;
    const uploaded = await api.request("/api/speaker-assets", {
      method: "POST",
      headers: speaker,
      body: JSON.stringify({
        profileId,
        name: "slides.pdf",
        contentType: "application/pdf",
        contentBase64: "AQID",
      }),
    });
    expect(uploaded.status).toBe(201);
    const assetId = (await uploaded.json()).asset.id;
    const unknownAssetId = "00000000-0000-4000-8000-0000000000ff";
    const anonymousRead = () => api.request(`/api/speaker-assets/${assetId}`);
    const ownerRead = () => api.request(`/api/speaker-assets/${assetId}`, { headers: speaker });

    expect(
      (
        await api.request(`/api/speaker-assets/${assetId}/publish`, {
          method: "POST",
          headers: organizer,
        })
      ).status,
    ).toBe(200);
    const live = await anonymousRead();
    expect(live.status).toBe(200);
    const validator = live.headers.get("etag");
    expect(validator).toBeTruthy();
    // Served bytes carry the correlation id like every other response; a raw `Response`
    // used to drop it, leaving an asset failure undiagnosable.
    expect(live.headers.get("x-correlation-id")).toBeTruthy();
    // Revalidation is a bodyless 304, which is what makes revalidating every read cheap.
    const revalidated = await api.request(`/api/speaker-assets/${assetId}`, {
      headers: { "if-none-match": validator ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe("public, no-cache");

    // Unpublishing the *event* withdraws the bytes its public page exposed. Live before this
    // change: an anonymous read stayed 200 whatever the event's publication state.
    publishedEvents.delete(eventId);
    expect((await anonymousRead()).status).toBe(404);
    // The people who could always read it still can — and never through a shared cache.
    const owner = await ownerRead();
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await api.request(`/api/speaker-assets/${assetId}`, { headers: organizer })).status,
    ).toBe(200);
    // Publishing the event again restores it: nothing about the asset was rewritten.
    publishedEvents.add(eventId);
    expect((await anonymousRead()).status).toBe(200);

    // Unpublishing the asset is organizer-only, and takes effect on the next read.
    expect(
      (
        await api.request(`/api/speaker-assets/${assetId}/unpublish`, {
          method: "POST",
          headers: speaker,
        })
      ).status,
    ).toBe(403);
    const unpublished = await api.request(`/api/speaker-assets/${assetId}/unpublish`, {
      method: "POST",
      headers: organizer,
    });
    expect(unpublished.status).toBe(200);
    expect((await unpublished.json()).asset.visibility).toBe("private");
    expect((await anonymousRead()).status).toBe(404);
    expect((await ownerRead()).status).toBe(200);
    // An id that does not exist and one on another organizer's event are refused the same way.
    for (const path of [`${unknownAssetId}/unpublish`, `${unknownAssetId}/publish`])
      expect(
        (await api.request(`/api/speaker-assets/${path}`, { method: "POST", headers: organizer }))
          .status,
      ).toBe(403);
    expect(
      (
        await api.request(`/api/speaker-assets/not-a-uuid/unpublish`, {
          method: "POST",
          headers: organizer,
        })
      ).status,
    ).toBe(400);

    // Deletion removes the row and the object together.
    expect(storage.objects.size).toBe(1);
    expect((await api.request(`/api/speaker-assets/${assetId}`, { method: "DELETE" })).status).toBe(
      401,
    );
    expect(
      (
        await api.request(`/api/speaker-assets/${assetId}`, {
          method: "DELETE",
          headers: await cookie("reviewer"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request(`/api/speaker-assets/${unknownAssetId}`, {
          method: "DELETE",
          headers: speaker,
        })
      ).status,
    ).toBe(403);
    const deleted = await api.request(`/api/speaker-assets/${assetId}`, {
      method: "DELETE",
      headers: speaker,
    });
    expect(deleted.status).toBe(204);
    expect(storage.objects.size).toBe(0);
    for (const headers of [{}, speaker, organizer])
      expect((await api.request(`/api/speaker-assets/${assetId}`, { headers })).status).toBe(404);
    // A deleted asset is now indistinguishable from one that never existed.
    expect(
      (await api.request(`/api/speaker-assets/${assetId}`, { method: "DELETE", headers: speaker }))
        .status,
    ).toBe(403);
    await expect(
      (await api.request(`/api/events/${eventId}/content`, { headers: organizer })).json(),
    ).resolves.toMatchObject({ assets: [] });
  });
  /*
   * A session's time, and the way a session leaves the programme.
   *
   * The portal and the .ics used to read `content_sessions.schedule_*`, which only the demo
   * seed ever wrote, so a speaker was served one date while the published schedule served
   * another and moving the session on the board changed nothing. Both now read the agenda
   * publication in force. `DELETE /api/content-sessions/{id}` is the withdrawal the decline
   * dialog names: it takes the session out of the programme and its placements off the board.
   */
  it("serves the agenda's published time and withdraws a session with its placements", async () => {
    const board = new MemoryAgendaRepository([
      {
        eventId,
        rooms: [{ id: "room-main", name: "Main stage" }],
        tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
        slots: [
          {
            id: "slot-0900",
            startsAt: "2026-09-01T16:00:00.000Z",
            endsAt: "2026-09-01T17:00:00.000Z",
          },
        ],
        sessions: [],
        placements: [],
      },
    ]);
    const api = app(new Set([eventId]), new DeterministicAssetStorage(), board);
    const organizer = await cookie("organizer");
    const speaker = await cookie("speaker");
    await decide(api, organizer, { proposalIds: [submittedProposalId], outcome: "accepted" });
    expect((await accept(api, organizer, submittedProposalId)).status).toBe(201);
    const created = await (
      await api.request(`/api/events/${eventId}/content`, { headers: organizer })
    ).json();
    const sessionId = created.sessions[0]?.id as string;

    // Nothing is placed yet, so the speaker is told nothing rather than something invented.
    expect(created.sessions[0]?.schedule).toBeUndefined();
    expect(
      (await api.request(`/api/events/${eventId}/speaker-calendar.ics`, { headers: speaker }))
        .status,
    ).toBe(404);

    await board.savePlacement(eventId, {
      id: "placement-opening",
      sessionId,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    });
    const placed = await board.getDraft(eventId);
    if (!placed) throw new Error("The seeded board is missing");
    await board.publish({
      eventId,
      version: 1,
      publishedAt: "2026-08-10T20:00:00.000Z",
      publishedBy: "seed-organizer",
      agenda: placed,
    });

    const portal = await (
      await api.request(`/api/events/${eventId}/content`, { headers: speaker })
    ).json();
    expect(portal.sessions[0]?.schedule).toEqual({
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
      location: "Main stage",
    });
    const calendar = await api.request(`/api/events/${eventId}/speaker-calendar.ics`, {
      headers: speaker,
    });
    expect(calendar.status).toBe(200);
    // The same instant the published schedule serves, not a second answer stored elsewhere.
    expect(await calendar.text()).toContain("DTSTART:20260901T160000Z");

    // Withdrawal is the organizer's, and only the organizer's.
    expect(
      (
        await api.request(`/api/content-sessions/${sessionId}`, {
          method: "DELETE",
          headers: speaker,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request("/api/content-sessions/not-a-uuid", {
          method: "DELETE",
          headers: organizer,
        })
      ).status,
    ).toBe(400);

    const withdrawn = await api.request(`/api/content-sessions/${sessionId}`, {
      method: "DELETE",
      headers: organizer,
    });
    expect(withdrawn.status).toBe(200);
    // The response is the programme the withdrawal produced, and the speaker survives it.
    await expect(withdrawn.json()).resolves.toMatchObject({ sessions: [], speakers: [{}] });
    expect((await board.getDraft(eventId))?.placements).toEqual([]);
    await expect(
      (await api.request(`/api/events/${eventId}/content`, { headers: organizer })).json(),
    ).resolves.toMatchObject({ sessions: [] });
  });

  it("answers a profile edit that never wins the record with 409 CONFLICT", async () => {
    // The store refuses the way `D1ContentRepository` does after losing the revision number
    // five times running. What is under test is the transport: contention has to reach the
    // organizer as a conflict they can resolve by reloading, not as a 500 or a silent 200.
    const contended = new MemoryContentRepository({
      sessions: [],
      speakers: [samProfile],
      tasks: [],
      assets: [],
      messages: [],
    });
    contended.reviseProfile = async () => {
      throw new ContentConflictError("This record is being edited by someone else.");
    };
    const api = app(undefined, undefined, undefined, contended);

    const response = await api.request(`/api/speaker-profiles/${samProfile.id}/workflow`, {
      method: "PATCH",
      headers: await cookie("organizer"),
      body: JSON.stringify({ workflowStatus: "ready", logistics: {}, customFields: {} }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", message: "This record is being edited by someone else." },
    });
  });
});
