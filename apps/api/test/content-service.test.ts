// @acceptance ACC-SPEAKER
import { describe, expect, it, vi } from "vitest";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { R2AssetStorage } from "../src/adapters/storage/r2-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import type { ContentSession } from "../src/domain/content/content";

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
const calendarSpeaker = {
  id: "profile-1",
  eventId,
  userId: "seed-speaker",
  sourcePersonId: "person-1",
  name: "Sam",
  email: "sam@example.test",
  bio: "",
  pronouns: "",
  organization: "",
};
function scheduledSession(overrides: Partial<ContentSession> = {}): ContentSession {
  return {
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
    ...overrides,
  };
}
function calendarService(
  sessions: ContentSession[],
  now = () => new Date("2026-08-10T12:00:00.000Z"),
) {
  return new ContentService({
    repository: new MemoryContentRepository({
      sessions,
      speakers: [calendarSpeaker],
      tasks: [],
      assets: [],
      messages: [],
    }),
    assetStorage: new DeterministicAssetStorage(),
    newId: crypto.randomUUID,
    now,
  });
}
/** RFC 5545 section 3.1 unfolding: a CRLF followed by one space rejoins a folded line. */
const calendarLines = (document: string) => document.replaceAll("\r\n ", "").split("\r\n");

describe("ContentService", () => {
  it("preserves speaker and organizer access when an actor has multiple event roles", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, {
      ...command,
      speakers: [
        ...command.speakers,
        {
          userId: "second-speaker",
          sourcePersonId: "person-2",
          name: "Second Speaker",
          email: "second@example.test",
        },
      ],
    });

    const speaker = await resolveSeededDemoActor("speaker");
    const reviewer = await resolveSeededDemoActor("reviewer");
    const reviewerSpeaker = {
      ...speaker,
      eventAccess: [
        reviewer.eventAccess[0] as NonNullable<(typeof reviewer.eventAccess)[number]>,
        ...speaker.eventAccess,
      ],
    };
    await expect(service.workspace(reviewerSpeaker, eventId)).resolves.toMatchObject({
      speakers: [{ userId: "seed-speaker" }],
    });

    const organizerSpeaker = {
      ...organizer,
      eventAccess: [...organizer.eventAccess, ...speaker.eventAccess],
    };
    const organizerWorkspace = await service.workspace(organizerSpeaker, eventId);
    expect(organizerWorkspace.speakers).toHaveLength(2);
  });

  it("serves uploaded assets only to the owner or an organizer until they are published", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, command);

    const speaker = await resolveSeededDemoActor("speaker");
    const workspace = await service.workspace(speaker, eventId);
    const profileId = workspace.speakers[0]?.id as string;
    const asset = await service.upload(speaker, {
      profileId,
      name: "headshot.png",
      contentType: "image/png",
      bytes: new Uint8Array([7, 7, 7]),
    });

    // The speaker who owns the profile, and organizers of the event, can read it.
    await expect(service.readAsset(speaker, asset.id)).resolves.toMatchObject({
      contentType: "image/png",
      bytes: new Uint8Array([7, 7, 7]),
    });
    await expect(service.readAsset(organizer, asset.id)).resolves.toMatchObject({
      contentType: "image/png",
    });

    // Nobody else can. Inaccessible and nonexistent are indistinguishable, so the route
    // cannot be used to enumerate which asset ids exist (ARC-AUTH-001).
    expect(await service.readAsset(null, asset.id)).toBeNull();
    const reviewer = await resolveSeededDemoActor("reviewer");
    expect(await service.readAsset(reviewer, asset.id)).toBeNull();
    expect(await service.readAsset(reviewer, "00000000-0000-4000-8000-0000000000fe")).toBeNull();

    // Publishing is what makes it public — nothing else.
    await service.publishAsset(organizer, asset.id);
    await expect(service.readAsset(null, asset.id)).resolves.toMatchObject({
      asset: { visibility: "publishable" },
    });

    expect(await service.readAsset(organizer, "00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  it("persists canonical bytes through the production R2 port", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const storage = new R2AssetStorage({
      put,
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    });
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
  it("emits a complete RFC 5545 document for the speaker's scheduled sessions", async () => {
    const service = calendarService([scheduledSession()]);
    // The whole document is asserted, not fragments of it, so dropping any property RFC 5545
    // makes mandatory — PRODID, VERSION, UID, DTSTAMP, DTSTART — fails this test.
    expect(await service.calendar(await resolveSeededDemoActor("speaker"), eventId)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Project Greenroom//Speaker Portal//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        "UID:session-1@greenroom",
        "DTSTAMP:20260810T120000Z",
        "DTSTART:20260915T170000Z",
        "DTEND:20260915T174500Z",
        "SUMMARY:A\\, B\\; and C\\nInjected",
        "LOCATION:Main\\; Stage",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });
  it("escapes TEXT values and drops characters RFC 5545 cannot carry", async () => {
    const service = calendarService([
      scheduledSession({ title: "Back\\slash, semi; colon\r\nsecondline\tkept" }),
    ]);
    const document = await service.calendar(await resolveSeededDemoActor("speaker"), eventId);
    expect(calendarLines(document)).toContain(
      "SUMMARY:Back\\\\slash\\, semi\\; colon\\nsecondline\tkept",
    );
    // A newline in stored data must never break out into a new content line.
    expect(document).not.toContain("\r\nsecond");
    // Every line break in the document is a CRLF.
    expect(document.replaceAll("\r\n", "")).not.toContain("\n");
  });
  it("folds long content lines at 75 octets without splitting a character", async () => {
    const title = "é".repeat(100);
    const service = calendarService([scheduledSession({ title })]);
    const document = await service.calendar(await resolveSeededDemoActor("speaker"), eventId);
    for (const line of document.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(document).toContain("\r\n ");
    // U+FFFD would appear only if a fold had landed inside a multi-octet character.
    expect(document).not.toContain("�");
    expect(calendarLines(document)).toContain(`SUMMARY:${title}`);
  });
  it("omits optional properties that carry no usable value", async () => {
    const { schedule: _unscheduled, ...unscheduledSession } = scheduledSession({
      id: "session-b",
      title: "Unscheduled",
    });
    const service = calendarService([
      scheduledSession({
        id: "session-a",
        title: "Instant",
        // DTEND must be later than DTSTART, and an empty location is not worth a property.
        schedule: {
          startsAt: "2026-09-15T17:00:00.000Z",
          endsAt: "2026-09-15T17:00:00.000Z",
          location: "",
        },
      }),
      unscheduledSession,
      scheduledSession({
        id: "session-c",
        title: "Unusable start",
        schedule: { startsAt: "2026-09-15T17:00:00", endsAt: "", location: "" },
      }),
    ]);
    expect(await service.calendar(await resolveSeededDemoActor("speaker"), eventId)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Project Greenroom//Speaker Portal//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        "UID:session-a@greenroom",
        "DTSTAMP:20260810T120000Z",
        "DTSTART:20260915T170000Z",
        "SUMMARY:Instant",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });
  it("stamps DTSTAMP from the injected clock and stays byte-for-byte deterministic", async () => {
    const speaker = await resolveSeededDemoActor("speaker");
    const service = calendarService([scheduledSession()]);
    const first = await service.calendar(speaker, eventId);
    expect(await service.calendar(speaker, eventId)).toBe(first);
    expect(calendarLines(first)).toContain("DTSTAMP:20260810T120000Z");
    const later = calendarService([scheduledSession()], () => new Date("2026-08-11T09:30:15.500Z"));
    expect(calendarLines(await later.calendar(speaker, eventId))).toContain(
      "DTSTAMP:20260811T093015Z",
    );
  });
});
