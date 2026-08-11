// @acceptance ACC-SPEAKER
import { describe, expect, it, vi } from "vitest";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";
const secret = "content-http-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
async function cookie(persona: "organizer" | "reviewer" | "speaker") {
  return {
    cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
    "content-type": "application/json",
  };
}
function app() {
  let id = 0;
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
    undefined,
    undefined,
    new ContentService({
      repository: new MemoryContentRepository(),
      assetStorage: new DeterministicAssetStorage(),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }),
  );
}
describe("content HTTP transport", () => {
  it("accepts once, returns a speaker-scoped portal, and denies reviewer access", async () => {
    const api = app();
    const body = JSON.stringify({
      proposalId: "proposal-1",
      title: "Accepted",
      abstract: "Abstract",
      format: "Talk",
      tags: [],
      tracks: [],
      speakers: [
        {
          userId: "seed-speaker",
          sourcePersonId: "person-1",
          name: "Sam",
          email: "sam@example.test",
        },
      ],
    });
    const duplicate = JSON.parse(body);
    duplicate.proposalId = "duplicate-person-proposal";
    duplicate.speakers.push({ ...duplicate.speakers[0] });
    const duplicateResponse = await api.request(`/api/events/${eventId}/content/accept`, {
      method: "POST",
      headers: await cookie("organizer"),
      body: JSON.stringify(duplicate),
    });
    expect(duplicateResponse.status).toBe(400);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      error: { fieldErrors: { "speakers.1.sourcePersonId": ["Each person may appear only once"] } },
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(
        (
          await api.request(`/api/events/${eventId}/content/accept`, {
            method: "POST",
            headers: await cookie("organizer"),
            body,
          })
        ).status,
      ).toBe(201);
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
          headers: await cookie("organizer"),
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
          headers: await cookie("organizer"),
          body: JSON.stringify({ profileId, subject: "Reminder sent" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api.request(
          `/api/events/${eventId}/tasks/00000000-0000-4000-8000-000000000004/complete`,
          { method: "POST", headers: await cookie("organizer") },
        )
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
        visibility: "publishable",
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
    const published = await api.request(`/api/speaker-assets/${uploadedAsset.id}/publish`, {
      method: "POST",
      headers: await cookie("organizer"),
    });
    expect(published.status).toBe(200);
    expect((await published.json()).asset.visibility).toBe("publishable");
    const sessionId = portalBody.sessions[0]?.id;
    const sessionInput = {
      title: "Managed session",
      abstract: "Managed abstract",
      format: "Workshop",
      speakerProfileIds: [profileId],
      tags: ["managed"],
      tracks: ["Studio"],
      publicationState: "ready",
    };
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
      headers: await cookie("organizer"),
      body: JSON.stringify(sessionInput),
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
            visibility: "private",
          }),
        })
      ).status,
    ).toBe(400);
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
});
