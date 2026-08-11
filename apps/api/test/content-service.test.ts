// @acceptance ACC-SPEAKER
import { describe, expect, it, vi } from "vitest";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { R2AssetStorage } from "../src/adapters/storage/r2-asset-storage";
import {
  ContentService,
  SpeakerIdentityUnavailableError,
} from "../src/application/content/content-service";
import type { SpeakerConversionPort } from "../src/application/content/speaker-conversion";
import {
  type AcceptedProposal,
  type AcceptedProposalQuery,
  ProposalNotAcceptedError,
  ProposalNotFoundError,
} from "../src/application/review/public";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import type { ContentSession, SpeakerProfile } from "../src/domain/content/content";

const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const correlationId = "content-service-correlation";
const command = { eventId, proposalId: "proposal-1" };

/** The speaker the demo seed already knows, so the portal assertions stay meaningful. */
const samProfile: SpeakerProfile = {
  id: "10000000-0000-4000-8000-000000000001",
  eventId,
  userId: "seed-speaker",
  sourcePersonId: "crm-email:sam@example.test",
  name: "Sam Speaker",
  email: "sam@example.test",
  bio: "",
  pronouns: "",
  organization: "",
};

const acceptedProposal = (overrides: Partial<AcceptedProposal> = {}): AcceptedProposal => ({
  eventId,
  proposalId: "proposal-1",
  title: "Calm systems",
  abstract: "Useful detail",
  format: "Talk",
  submitter: { name: "Sam Speaker", email: "sam@example.test" },
  decidedAt: "2026-08-10T11:00:00.000Z",
  ...overrides,
});

/**
 * Stands in for `ReviewService`, which is the only thing that can answer "is this proposal
 * accepted?". Ids it does not know are indistinguishable from ids belonging to another event.
 */
class FakeAcceptedProposals implements AcceptedProposalQuery {
  constructor(
    private readonly accepted: readonly AcceptedProposal[],
    private readonly submittedButUndecided: readonly string[] = [],
  ) {}
  async acceptedProposal(scopedEventId: string, proposalId: string) {
    const found = this.accepted.find(
      (item) => item.proposalId === proposalId && item.eventId === scopedEventId,
    );
    if (found) return found;
    if (this.submittedButUndecided.includes(proposalId))
      throw new ProposalNotAcceptedError("Proposal has no recorded acceptance decision");
    throw new ProposalNotFoundError("Proposal not found for this event");
  }
}

function setup(
  options: {
    proposals?: AcceptedProposalQuery;
    speakerConversion?: (repository: MemoryContentRepository, newId: () => string) => unknown;
    seedSpeaker?: boolean;
    /** Events whose public page is live. An asset is public only while its event is. */
    publishedEvents?: Set<string>;
  } = {},
) {
  const publishedEvents = options.publishedEvents ?? new Set([eventId]);
  const repository = new MemoryContentRepository(
    options.seedSpeaker === false
      ? undefined
      : { sessions: [], speakers: [samProfile], tasks: [], assets: [], messages: [] },
  );
  const storage = new DeterministicAssetStorage();
  let id = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  return {
    repository,
    storage,
    publishedEvents,
    service: new ContentService({
      repository,
      assetStorage: storage,
      proposals:
        options.proposals ??
        new FakeAcceptedProposals([
          acceptedProposal(),
          acceptedProposal({ proposalId: "proposal-2", title: "Second session" }),
        ]),
      speakerConversion: (options.speakerConversion?.(repository, newId) ??
        new MemorySpeakerConversion(repository, newId)) as SpeakerConversionPort,
      eventPublication: { isEventPublished: async (id) => publishedEvents.has(id) },
      newId,
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
  const repository = new MemoryContentRepository({
    sessions,
    speakers: [calendarSpeaker],
    tasks: [],
    assets: [],
    messages: [],
  });
  return new ContentService({
    repository,
    assetStorage: new DeterministicAssetStorage(),
    proposals: new FakeAcceptedProposals([]),
    speakerConversion: new MemorySpeakerConversion(repository, crypto.randomUUID),
    newId: crypto.randomUUID,
    now,
  });
}
/** RFC 5545 section 3.1 unfolding: a CRLF followed by one space rejoins a folded line. */
const calendarLines = (document: string) => document.replaceAll("\r\n ", "").split("\r\n");

describe("ContentService", () => {
  it("preserves speaker and organizer access when an actor has multiple event roles", async () => {
    const { service } = setup({
      proposals: new FakeAcceptedProposals([
        acceptedProposal(),
        acceptedProposal({
          proposalId: "proposal-2",
          title: "Second session",
          submitter: { name: "Second Speaker", email: "second@example.test" },
        }),
      ]),
    });
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, command, correlationId);
    await service.accept(organizer, { eventId, proposalId: "proposal-2" }, correlationId);

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

  it("refuses to invent content for a proposal the review domain does not vouch for", async () => {
    const { service, repository } = setup({
      proposals: new FakeAcceptedProposals([acceptedProposal()], ["submitted-not-decided"]),
    });
    const organizer = await resolveSeededDemoActor("organizer");

    // The exact live defect from issue #65: a fabricated id used to create a session.
    await expect(
      service.accept(organizer, { eventId, proposalId: "totally-made-up-proposal-id" }, "c-1"),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    // A real proposal that belongs to a different event is equally unusable, and reports the
    // same error so acceptance cannot enumerate another event's proposals.
    await expect(
      service.accept(organizer, { eventId: otherEventId, proposalId: "proposal-1" }, "c-2"),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    // Submitted is not accepted.
    await expect(
      service.accept(organizer, { eventId, proposalId: "submitted-not-decided" }, "c-3"),
    ).rejects.toBeInstanceOf(ProposalNotAcceptedError);

    const workspace = await repository.workspace(eventId);
    expect(workspace.sessions).toHaveLength(0);
    expect(workspace.speakers).toEqual([samProfile]);
  });

  it("reports an unusable speaker identity as a field error instead of a server fault", async () => {
    const { service } = setup({
      speakerConversion: () => ({
        createOrLink: async () => {
          throw new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT");
        },
      }),
    });
    const organizer = await resolveSeededDemoActor("organizer");
    // ERROR-INTENT: the rejection is the assertion subject; it is inspected on the next line.
    const failure = await service.accept(organizer, command, correlationId).catch((error) => error);
    expect(failure).toBeInstanceOf(SpeakerIdentityUnavailableError);
    expect((failure as SpeakerIdentityUnavailableError).fields).toHaveProperty("submitter.email");
  });

  it("keeps an infrastructure failure in speaker conversion a server fault", async () => {
    const { service } = setup({
      speakerConversion: () => ({
        createOrLink: async () => {
          throw new Error("D1 is unreachable");
        },
      }),
    });
    await expect(
      service.accept(await resolveSeededDemoActor("organizer"), command, correlationId),
    ).rejects.toThrow("D1 is unreachable");
  });

  it("resolves the speaker from the proposal rather than from the caller", async () => {
    const { service, repository } = setup({ seedSpeaker: false });
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, command, correlationId);
    const workspace = await repository.workspace(eventId);
    // Provisioned by the conversion port, keyed on the submitted address — the caller never
    // named a `userId`, so there is no client-supplied foreign key to fail on.
    expect(workspace.speakers).toMatchObject([
      {
        email: "sam@example.test",
        name: "Sam Speaker",
        sourcePersonId: "crm-email:sam@example.test",
      },
    ]);
    expect(workspace.sessions).toMatchObject([
      {
        title: "Calm systems",
        abstract: "Useful detail",
        format: "Talk",
        proposalId: "proposal-1",
      },
    ]);
  });

  it("serves uploaded assets only to the owner or an organizer until they are published", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.accept(organizer, command, correlationId);

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
      // Only this door permits a shared cache to keep the bytes.
      publiclyReadable: true,
    });

    expect(await service.readAsset(organizer, "00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  it("ties a published asset to the event's publication state and to deletion", async () => {
    const { service, storage, repository, publishedEvents } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const speaker = await resolveSeededDemoActor("speaker");
    await service.accept(organizer, command, correlationId);
    const profileId = (await service.workspace(speaker, eventId)).speakers[0]?.id as string;
    const asset = await service.upload(speaker, {
      profileId,
      name: "headshot.png",
      contentType: "image/png",
      bytes: new Uint8Array([7]),
    });
    await service.publishAsset(organizer, asset.id);
    expect(await service.readAsset(null, asset.id)).not.toBeNull();

    // Taking the event's public page down takes its assets with it. The organizer and the
    // owning speaker keep their own access, and it is not marked cacheable for them.
    publishedEvents.delete(eventId);
    expect(await service.readAsset(null, asset.id)).toBeNull();
    await expect(service.readAsset(speaker, asset.id)).resolves.toMatchObject({
      publiclyReadable: false,
    });
    await expect(service.readAsset(organizer, asset.id)).resolves.toMatchObject({
      publiclyReadable: false,
    });
    // Nothing was rewritten, so publishing the event again restores the public read.
    publishedEvents.add(eventId);
    await expect(service.readAsset(null, asset.id)).resolves.toMatchObject({
      publiclyReadable: true,
    });

    // Retracting the asset itself is organizer work, and reversible in its own right.
    await expect(service.unpublishAsset(speaker, asset.id)).rejects.toThrow();
    await expect(service.unpublishAsset(organizer, asset.id)).resolves.toMatchObject({
      visibility: "private",
    });
    expect(await service.readAsset(null, asset.id)).toBeNull();
    await service.publishAsset(organizer, asset.id);

    // A profile photo that pointed at the asset must not survive it, or the public page
    // would advertise a URL that 404s.
    await repository.updateProfile({
      ...(await repository.findProfile(profileId)),
      photoAssetId: asset.id,
    } as NonNullable<Awaited<ReturnType<typeof repository.findProfile>>>);
    await expect(
      service.deleteAsset(await resolveSeededDemoActor("reviewer"), asset.id),
    ).rejects.toThrow();
    await service.deleteAsset(speaker, asset.id);
    expect(storage.objects.size).toBe(0);
    expect(await repository.findAsset(asset.id)).toBeNull();
    expect((await repository.findProfile(profileId))?.photoAssetId).toBeUndefined();
    expect(await service.readAsset(organizer, asset.id)).toBeNull();
    // Deleting again is refused exactly like deleting something that never existed.
    await expect(service.deleteAsset(organizer, asset.id)).rejects.toThrow();
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
    const repository = new FailingAssetRepository({
      sessions: [],
      speakers: [samProfile],
      tasks: [],
      assets: [],
      messages: [],
    });
    const storage = new DeterministicAssetStorage();
    let id = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
    const service = new ContentService({
      repository,
      assetStorage: storage,
      proposals: new FakeAcceptedProposals([acceptedProposal()]),
      speakerConversion: new MemorySpeakerConversion(repository, newId),
      newId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const accepted = await service.accept(
      await resolveSeededDemoActor("organizer"),
      command,
      correlationId,
    );
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
    await service.accept(organizer, command, correlationId);
    const twice = await service.accept(organizer, command, correlationId);
    expect(twice.sessions).toHaveLength(1);
    expect(twice.sessions[0]?.proposalId).toBe("proposal-1");
    expect(twice.speakers).toHaveLength(1);
    expect(twice.tasks).toHaveLength(2);
    await service.accept(organizer, { eventId, proposalId: "proposal-2" }, correlationId);
    const linked = await service.workspace(organizer, eventId);
    expect(linked.sessions).toHaveLength(2);
    expect(linked.speakers).toHaveLength(1);
    // The second acceptance reuses the person, so the onboarding checklist is not reissued.
    expect(linked.tasks).toHaveLength(2);
    expect(
      new Set(linked.sessions.flatMap(({ speakerProfileIds }) => speakerProfileIds)).size,
    ).toBe(1);
  });
  it("scopes the portal to the assigned speaker and protects uploads", async () => {
    const { service, storage } = setup();
    await service.accept(await resolveSeededDemoActor("organizer"), command, correlationId);
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
    const accepted = await service.accept(organizer, command, correlationId);
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
      scheduledSession({ title: "Back\\slash, semi; colon\r\nsecondline\tkept" }),
    ]);
    const document = (await service.calendar(
      await resolveSeededDemoActor("speaker"),
      eventId,
    )) as string;
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
    const document = (await service.calendar(
      await resolveSeededDemoActor("speaker"),
      eventId,
    )) as string;
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
  it("has no calendar at all when no session yields a component", async () => {
    const speaker = await resolveSeededDemoActor("speaker");
    const { schedule: _dropped, ...unscheduled } = scheduledSession();
    // RFC 5545 section 3.4: `icalbody = calprops component` with `component = 1*(...)`. A
    // VCALENDAR carrying only calprops is not an iCalendar object, and Apple and Google both
    // refuse to import one, so nothing is produced rather than something unusable.
    expect(await calendarService([]).calendar(speaker, eventId)).toBeNull();
    expect(await calendarService([unscheduled]).calendar(speaker, eventId)).toBeNull();
    expect(
      await calendarService([
        scheduledSession({ schedule: { startsAt: "not-a-date", endsAt: "", location: "" } }),
      ]).calendar(speaker, eventId),
    ).toBeNull();
    // A zone-less local time cannot be expressed as a UTC DATE-TIME either.
    expect(
      await calendarService([
        scheduledSession({
          schedule: { startsAt: "2026-09-15T17:00:00", endsAt: "", location: "" },
        }),
      ]).calendar(speaker, eventId),
    ).toBeNull();
  });
  it("stamps DTSTAMP from the injected clock and stays byte-for-byte deterministic", async () => {
    const speaker = await resolveSeededDemoActor("speaker");
    const service = calendarService([scheduledSession()]);
    const first = (await service.calendar(speaker, eventId)) as string;
    expect(await service.calendar(speaker, eventId)).toBe(first);
    expect(calendarLines(first)).toContain("DTSTAMP:20260810T120000Z");
    const later = calendarService([scheduledSession()], () => new Date("2026-08-11T09:30:15.500Z"));
    expect(calendarLines((await later.calendar(speaker, eventId)) as string)).toContain(
      "DTSTAMP:20260811T093015Z",
    );
  });
});
