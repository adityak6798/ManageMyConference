// @acceptance ACC-SPEAKER
import { describe, expect, it, vi } from "vitest";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { R2AssetStorage } from "../src/adapters/storage/r2-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";

const eventId = "00000000-0000-4000-8000-000000000001";
const command = {
  eventId,
  proposalId: "proposal-1",
  title: "Calm systems",
  abstract: "Useful detail",
  format: "Talk",
  tags: ["ops"],
  tracks: ["Main"],
  speakers: [
    {
      userId: "seed-speaker",
      sourcePersonId: "person-1",
      name: "Sam Speaker",
      email: "sam@example.test",
    },
  ],
};
function setup() {
  const repository = new MemoryContentRepository();
  const storage = new DeterministicAssetStorage();
  let id = 0;
  return {
    repository,
    storage,
    service: new ContentService({
      repository,
      assetStorage: storage,
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }),
  };
}
describe("ContentService", () => {
  it("persists canonical bytes through the production R2 port", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const storage = new R2AssetStorage({ put, delete: vi.fn().mockResolvedValue(undefined) });
    await expect(
      storage.put({
        key: "event/profile/asset",
        contentType: "image/png",
        bytes: new Uint8Array([1, 2]),
      }),
    ).resolves.toEqual({ key: "event/profile/asset" });
    expect(put).toHaveBeenCalledWith("event/profile/asset", new Uint8Array([1, 2]), {
      httpMetadata: { contentType: "image/png" },
    });
  });
  it("removes an R2 object when asset metadata persistence fails", async () => {
    class FailingAssetRepository extends MemoryContentRepository {
      override async addAsset() {
        throw new Error("metadata unavailable");
      }
    }
    const repository = new FailingAssetRepository();
    const storage = new DeterministicAssetStorage();
    let id = 0;
    const service = new ContentService({
      repository,
      assetStorage: storage,
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const accepted = await service.accept(await resolveSeededDemoActor("organizer"), command);
    await expect(
      service.upload(await resolveSeededDemoActor("speaker"), {
        profileId: accepted.speakers[0]?.id ?? "",
        name: "headshot.png",
        contentType: "image/png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("metadata unavailable");
    expect(storage.objects.size).toBe(0);
  });
  it("converts an acceptance idempotently while preserving proposal provenance", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, command);
    const twice = await service.accept(organizer, command);
    expect(twice.sessions).toHaveLength(1);
    expect(twice.sessions[0]?.proposalId).toBe("proposal-1");
    expect(twice.speakers).toHaveLength(1);
    expect(twice.tasks).toHaveLength(2);
    await service.accept(organizer, {
      ...command,
      proposalId: "proposal-2",
      title: "Second session",
    });
    const linked = await service.workspace(organizer, eventId);
    expect(linked.sessions).toHaveLength(2);
    expect(linked.speakers).toHaveLength(1);
    expect(
      new Set(linked.sessions.flatMap(({ speakerProfileIds }) => speakerProfileIds)).size,
    ).toBe(1);
  });
  it("scopes the portal to the assigned speaker and protects uploads", async () => {
    const { service, storage } = setup();
    await service.accept(await resolveSeededDemoActor("organizer"), command);
    const speaker = await resolveSeededDemoActor("speaker");
    const portal = await service.workspace(speaker, eventId);
    const profile = portal.speakers[0];
    expect(profile?.userId).toBe("seed-speaker");
    const asset = await service.upload(speaker, {
      profileId: profile?.id ?? "",
      name: "headshot.png",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2]),
    });
    expect(asset.visibility).toBe("private");
    expect(storage.objects.has(asset.storageKey)).toBe(true);
    await expect(service.publishAsset(speaker, asset.id)).rejects.toThrow();
    const organizer = await resolveSeededDemoActor("organizer");
    await expect(service.publishAsset(organizer, asset.id)).resolves.toMatchObject({
      visibility: "publishable",
    });
    const session = portal.sessions[0];
    await expect(
      service.updateSession(organizer, session?.id ?? "", {
        title: "Updated session",
        abstract: "Updated abstract",
        format: "Workshop",
        speakerProfileIds: [profile?.id ?? ""],
        tags: ["updated"],
        tracks: ["Studio"],
        publicationState: "ready",
      }),
    ).resolves.toMatchObject({ title: "Updated session", publicationState: "ready" });
    await expect(
      service.updateSession(speaker, session?.id ?? "", {
        title: "Forbidden",
        abstract: "Updated abstract",
        format: "Workshop",
        speakerProfileIds: [profile?.id ?? ""],
        tags: [],
        tracks: [],
        publicationState: "published",
      }),
    ).rejects.toThrow();
    await expect(
      service.workspace(await resolveSeededDemoActor("reviewer"), eventId),
    ).rejects.toThrow();
    await expect(
      service.completeTask(
        await resolveSeededDemoActor("organizer"),
        portal.tasks[0]?.id ?? "",
        eventId,
      ),
    ).rejects.toThrow();
  });
  it("lets organizers request speaker work and record communication", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const accepted = await service.accept(organizer, command);
    const profileId = accepted.speakers[0]?.id ?? "";
    await service.requestTask(organizer, {
      profileId,
      title: "Upload final slides",
      dueAt: "2026-09-01T23:59:00.000Z",
    });
    await service.recordMessage(organizer, { profileId, subject: "Preparation reminder sent" });
    const workspace = await service.workspace(organizer, eventId);
    expect(workspace.tasks.map(({ title }) => title)).toContain("Upload final slides");
    expect(workspace.messages.map(({ subject }) => subject)).toContain("Preparation reminder sent");
  });
  it("emits byte-for-byte deterministic calendar output from canonical schedule data", async () => {
    const repository = new MemoryContentRepository({
      sessions: [
        {
          id: "session-1",
          eventId,
          proposalId: "proposal-1",
          title: "A, B; and C\r\nInjected",
          abstract: "",
          format: "Talk",
          speakerProfileIds: ["profile-1"],
          tags: [],
          tracks: [],
          publicationState: "ready",
          schedule: {
            startsAt: "2026-09-15T17:00:00.000Z",
            endsAt: "2026-09-15T17:45:00.000Z",
            location: "Main; Stage",
          },
        },
      ],
      speakers: [
        {
          id: "profile-1",
          eventId,
          userId: "seed-speaker",
          sourcePersonId: "person-1",
          name: "Sam",
          email: "sam@example.test",
          bio: "",
          pronouns: "",
          organization: "",
        },
      ],
      tasks: [],
      assets: [],
      messages: [],
    });
    const service = new ContentService({
      repository,
      assetStorage: new DeterministicAssetStorage(),
      newId: crypto.randomUUID,
      now: () => new Date(),
    });
    const speaker = await resolveSeededDemoActor("speaker");
    const first = await service.calendar(speaker, eventId);
    expect(await service.calendar(speaker, eventId)).toBe(first);
    expect(first).toContain("DTSTART:20260915T170000Z");
    expect(first).toContain("SUMMARY:A\\, B\\; and C\\nInjected");
    expect(first).not.toContain("\r\nInjected");
  });
});
