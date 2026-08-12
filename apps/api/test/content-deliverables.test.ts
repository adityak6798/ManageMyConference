// @acceptance ACC-SPEAKER

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDeliverablesZip } from "../src/adapters/content/create-deliverables-zip";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const profileId = "10000000-0000-4000-8000-000000000001";
const speaker: Actor = {
  id: "speaker-user",
  name: "Sam Speaker",
  persona: "speaker",
  organizations: [],
  capabilities: new Set(["content:read"]),
  eventAccess: [{ eventId, role: "speaker", capabilities: new Set(["content:read"]) }],
};
const organizer: Actor = {
  id: "organizer-user",
  name: "Ona Organizer",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(["content:read", "content:manage"]),
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["content:read", "content:manage"]) },
  ],
};

function fixture() {
  const repository = new MemoryContentRepository({
    sessions: [],
    speakers: [
      {
        id: profileId,
        eventId,
        userId: speaker.id,
        sourcePersonId: "source",
        name: "Sam",
        email: "sam@example.test",
        bio: "old",
        pronouns: "",
        organization: "",
      },
    ],
    tasks: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        eventId,
        speakerProfileId: profileId,
        title: "Slides",
        dueAt: "2026-09-01T00:00:00.000Z",
        status: "open",
        type: "file-request",
        instructions: "PDF",
      },
    ],
    assets: [],
    messages: [],
  });
  let sequence = 0;
  const service = new ContentService({
    repository,
    assetStorage: new DeterministicAssetStorage(),
    proposals: {
      acceptedProposal: async () => {
        throw new Error("unused");
      },
    },
    agenda: {
      publishedSessionSchedules: async () => new Map(),
      publishedScheduleVersion: async () => null,
      unscheduleSession: async () => undefined,
    },
    speakerConversion: { createOrLink: async () => ({ speakerId: profileId }) },
    newId: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    createDeliverablesZip,
  });
  return { repository, service };
}

describe("versioned and discussable deliverables", () => {
  it("keeps prior versions readable and marks only the newest latest", async () => {
    const { repository, service } = fixture();
    const first = await service.upload(speaker, {
      profileId,
      name: "slides.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
      taskId: "30000000-0000-4000-8000-000000000001",
    });
    const second = await service.upload(speaker, {
      profileId,
      name: "slides-v2.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([2]),
      versionGroupId: first.versionGroupId,
    });
    const assets = (await repository.workspace(eventId)).assets;
    expect(assets.map(({ versionNumber, isLatest }) => [versionNumber, isLatest])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(await service.readAsset(speaker, first.id)).not.toBeNull();
    expect(second.versionGroupId).toBe(first.versionGroupId);
    expect(second.taskId).toBe(first.taskId);
    const archive = await service.bulkDownload(organizer, eventId, [second.id]);
    expect(Object.keys(unzipSync(archive))).toEqual(["slides-v2.pdf"]);
    await expect(service.bulkDownload(organizer, eventId, [first.id])).rejects.toThrow();
    await service.deleteAsset(speaker, second.id);
    expect(await repository.findAsset(first.id)).toMatchObject({ isLatest: true });
  });

  it("round-trips attributed comments and restores an attributed profile revision", async () => {
    const { repository, service } = fixture();
    const asset = await service.upload(speaker, {
      profileId,
      name: "slides.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
    });
    const comment = await service.addAssetComment(organizer, asset.id, "Please add alt text");
    expect(comment).toMatchObject({ authorId: organizer.id, authorName: organizer.name });
    await service.updateMyProfile(speaker, profileId, {
      name: "Sam",
      bio: "new",
      pronouns: "",
      organization: "",
    });
    const revision = (await repository.workspace(eventId)).revisions?.[0];
    expect(revision?.actorId).toBe(speaker.id);
    await service.restoreRevision(organizer, revision?.id ?? "");
    expect((await repository.findProfile(profileId))?.bio).toBe("old");
    await service.updateSpeakerWorkflow(organizer, profileId, {
      workflowStatus: "ready",
      logistics: { hotel: "confirmed" },
      customFields: { shirt: "M" },
    });
    const workflowRevision = (await repository.workspace(eventId)).revisions?.at(-1);
    expect(workflowRevision?.snapshotJson).toContain('"bio":"old"');
  });

  it("restores the fields an edit can change, and only those", async () => {
    const { repository, service } = fixture();
    // A revision taken before the speaker had a headshot, and before anything touched the
    // identity a profile carries from speaker conversion.
    await service.updateMyProfile(speaker, profileId, {
      name: "Sam",
      bio: "written after the snapshot",
      pronouns: "they/them",
      organization: "Greenroom Labs",
    });
    const revision = (await repository.workspace(eventId)).revisions?.[0];
    const asset = await service.upload(speaker, {
      profileId,
      name: "portrait.png",
      contentType: "image/png",
      bytes: new Uint8Array([1]),
    });
    await service.setProfilePhoto(organizer, profileId, asset.id);
    // The identity columns no edit writes. A snapshot carrying an older address must not appear
    // to put it back, because no repository would have stored it if it tried.
    await repository.updateProfile({
      ...((await repository.findProfile(profileId)) as NonNullable<
        Awaited<ReturnType<typeof repository.findProfile>>
      >),
      email: "moved@example.test",
    });

    await service.restoreRevision(organizer, revision?.id ?? "");

    const restored = await repository.findProfile(profileId);
    expect(restored).toMatchObject({ bio: "old", pronouns: "", organization: "" });
    // Chosen after the snapshot was taken, so restoring that snapshot takes it back off.
    expect(restored).not.toHaveProperty("photoAssetId");
    // Never restorable: identity is not an editable field, whatever a snapshot happens to hold.
    expect(restored).toMatchObject({
      email: "moved@example.test",
      sourcePersonId: "source",
      userId: speaker.id,
      eventId,
    });
  });
});
