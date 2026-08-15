// @acceptance ACC-SPEAKER
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { R2AssetStorage } from "../src/adapters/storage/r2-asset-storage";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { ContentConflictError } from "../src/application/content/content-repository";
import type {
  ContentActorDirectoryPort,
  ContentProfileAuditPort,
  SpeakerNotificationPort,
} from "../src/application/content/content-service";
import {
  ContentService,
  SpeakerChecklistTitleTakenError,
  SpeakerIdentityUnavailableError,
  SpeakerPhotoInvalidError,
} from "../src/application/content/content-service";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import type { SpeakerConversionPort } from "../src/application/content/speaker-conversion";
import { type Actor, CapabilityDeniedError } from "../src/application/identity/actor";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import {
  type AcceptedProposal,
  type AcceptedProposalQuery,
  ProposalNotAcceptedError,
  ProposalNotFoundError,
} from "../src/application/review/public";
import type { AgendaDraft } from "../src/domain/agenda/agenda";
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
  jobTitle: "",
  organization: "",
  version: 0,
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
    /** Agenda boards this event starts with, so a withdrawal has placements to drop. */
    drafts?: readonly AgendaDraft[];
    /** Records what content asked to have sent, for the lifecycle-trigger tests (issue #66). */
    speakerNotifications?: SpeakerNotificationPort;
    /** Identity's answer to "what is this person called?" (issue #154). */
    identities?: ContentActorDirectoryPort;
    profileAudit?: ContentProfileAuditPort;
  } = {},
) {
  const publishedEvents = options.publishedEvents ?? new Set([eventId]);
  const repository = new MemoryContentRepository(
    options.seedSpeaker === false
      ? undefined
      : {
          sessions: [],
          speakers: [samProfile],
          tasks: [],
          assets: [],
          messages: [],
        },
  );
  const storage = new DeterministicAssetStorage();
  let id = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const agendaRepository = new MemoryAgendaRepository(options.drafts ?? []);
  const agenda = agendaService(agendaRepository);
  return {
    repository,
    storage,
    publishedEvents,
    agenda,
    agendaRepository,
    service: new ContentService({
      repository,
      ...(options.speakerNotifications
        ? { speakerNotifications: options.speakerNotifications }
        : {}),
      ...(options.identities ? { identities: options.identities } : {}),
      ...(options.profileAudit ? { profileAudit: options.profileAudit } : {}),
      assetStorage: storage,
      proposals:
        options.proposals ??
        new FakeAcceptedProposals([
          acceptedProposal(),
          acceptedProposal({
            proposalId: "proposal-2",
            title: "Second session",
          }),
        ]),
      agenda,
      speakerConversion: (options.speakerConversion?.(repository, newId) ??
        new MemorySpeakerConversion(repository, newId)) as SpeakerConversionPort,
      eventPublication: {
        isEventPublished: async (id) => publishedEvents.has(id),
      },
      newId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }),
  };
}

/**
 * The real agenda service over an in-memory board.
 *
 * The schedule content serves is the one the agenda published, so these tests cross that
 * boundary for real rather than through a hand-written map: a placement, its slot, and its room
 * are what produce a `DTSTART`, a `DTEND`, and a `LOCATION`.
 */
function agendaService(repository: MemoryAgendaRepository) {
  return new AgendaService(
    repository,
    () => new Date("2026-08-10T12:00:00.000Z"),
    new FixtureSchedulableContentQuery(new Map()),
  );
}

/** One published agenda placing each named session in its own room and slot. */
function publishedAgenda(
  entries: readonly {
    sessionId: string;
    startsAt: string;
    endsAt: string;
    location: string;
  }[],
  version = 1,
): PublishedSchedule {
  return {
    eventId,
    version,
    publishedAt: "2026-08-10T12:00:00.000Z",
    publishedBy: "seed-organizer",
    agenda: {
      eventId,
      rooms: entries.map((entry, index) => ({
        id: `room-${index}`,
        name: entry.location,
      })),
      tracks: [{ id: "track-1", name: "Platform", color: "#6257d9" }],
      slots: entries.map((entry, index) => ({
        id: `slot-${index}`,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
      })),
      sessions: [],
      placements: entries.map((entry, index) => ({
        id: `placement-${index}`,
        sessionId: entry.sessionId,
        roomId: `room-${index}`,
        trackId: "track-1",
        slotId: `slot-${index}`,
      })),
    },
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
function session(overrides: Partial<ContentSession> = {}): ContentSession {
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
    ...overrides,
  };
}
/** The placement the agenda published for `session-1` unless a test says otherwise. */
const openingPlacement = {
  sessionId: "session-1",
  startsAt: "2026-09-15T17:00:00.000Z",
  endsAt: "2026-09-15T17:45:00.000Z",
  location: "Main; Stage",
};
function calendarService(
  sessions: ContentSession[],
  placements: readonly {
    sessionId: string;
    startsAt: string;
    endsAt: string;
    location: string;
  }[] = [openingPlacement],
  now = () => new Date("2026-08-10T12:00:00.000Z"),
) {
  const repository = new MemoryContentRepository({
    sessions,
    speakers: [calendarSpeaker],
    tasks: [],
    assets: [],
    messages: [],
  });
  const agendaRepository = new MemoryAgendaRepository(
    [],
    placements.length ? [publishedAgenda(placements)] : [],
  );
  return new ContentService({
    repository,
    assetStorage: new DeterministicAssetStorage(),
    proposals: new FakeAcceptedProposals([]),
    agenda: agendaService(agendaRepository),
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

  it("names an event's staff to organizers and to nobody else", async () => {
    // `listAssignableOwnersForEvent` returns the event's organizers *and* its reviewers, so this
    // directory is the roster of everyone staffing the event. It exists to turn the actor id on a
    // revision into a name in Edit history (#154), which only organizers see — and the speaker
    // projection carries no revisions to attribute. Publishing it to a speaker reading their own
    // portal would be an information disclosure with nothing asking for it, so the guard that
    // withholds it is asserted in both directions rather than left to the one client that reads it.
    const asked: string[] = [];
    const identities: ContentActorDirectoryPort = {
      listAssignableOwnersForEvent: async (id) => {
        asked.push(id);
        return [
          { id: "seed-organizer", name: "Olivia Organizer" },
          { id: "seed-reviewer", name: "Ravi Reviewer" },
        ];
      },
    };
    const { service } = setup({ identities });

    const organizerWorkspace = await service.workspace(
      await resolveSeededDemoActor("organizer"),
      eventId,
    );
    expect(organizerWorkspace.actorDirectory).toEqual([
      { id: "seed-organizer", name: "Olivia Organizer" },
      { id: "seed-reviewer", name: "Ravi Reviewer" },
    ]);
    expect(asked).toEqual([eventId]);

    const speakerWorkspace = await service.workspace(
      await resolveSeededDemoActor("speaker"),
      eventId,
    );
    expect(speakerWorkspace.actorDirectory).toBeUndefined();
    // Not merely absent from the response — never asked for, so a speaker's read does not spend a
    // query on a roster they must not receive.
    expect(asked).toEqual([eventId]);
  });

  it("falls back to unattributed history when no identity directory is bound", async () => {
    // `identities` is optional, and a composition without it must still serve the workspace —
    // the console then prints the stored id, which is what it did before #154.
    const { service } = setup();
    const workspace = await service.workspace(await resolveSeededDemoActor("organizer"), eventId);
    expect(workspace.actorDirectory).toBeUndefined();
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

  it("lets the speaker and an organizer choose a headshot, and nobody else", async () => {
    const { service, repository } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const speaker = await resolveSeededDemoActor("speaker");
    await service.accept(organizer, command, correlationId);
    const profileId = (await service.workspace(speaker, eventId)).speakers[0]?.id as string;
    const upload = (name: string, contentType: string) =>
      service.upload(speaker, {
        profileId,
        name,
        contentType,
        bytes: new Uint8Array([9]),
      });
    const headshot = await upload("headshot.png", "image/png");
    const slides = await upload("slides.pdf", "application/pdf");

    // The speaker's own portal action: this is the write that did not exist.
    await expect(
      service.setProfilePhoto(speaker, profileId, headshot.id, 0),
    ).resolves.toMatchObject({
      id: profileId,
      photoAssetId: headshot.id,
    });
    expect((await repository.findProfile(profileId))?.photoAssetId).toBe(headshot.id);

    // Choosing a face is not publishing it. The asset keeps the visibility it had, so the
    // public door stays shut and the gallery keeps drawing initials.
    expect((await repository.findAsset(headshot.id))?.visibility).toBe("private");
    expect(await service.readAsset(null, headshot.id)).toBeNull();

    // An organizer of the event may set it too — they own the programme it appears on.
    await service.clearProfilePhoto(organizer, profileId, 1);
    expect((await repository.findProfile(profileId))?.photoAssetId).toBeUndefined();
    await expect(
      service.setProfilePhoto(organizer, profileId, headshot.id, 2),
    ).resolves.toMatchObject({ photoAssetId: headshot.id });

    // Nobody else: a reviewer on the event, a speaker who is not this speaker, and an
    // anonymous caller are all refused, and refused the same way as an unknown profile.
    const strangerSpeaker = { ...speaker, id: "another-speaker" };
    const outsideOrganizer = {
      ...organizer,
      organizations: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          name: "Another organization",
        },
      ],
      organizationAccess: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          capabilities: new Set(organizer.capabilities),
        },
      ],
      eventAccess: [
        {
          eventId: "00000000-0000-4000-8000-000000000099",
          role: "organizer" as const,
          capabilities: new Set(["content:read" as const, "content:manage" as const]),
        },
      ],
    };
    for (const actor of [
      null,
      await resolveSeededDemoActor("reviewer"),
      strangerSpeaker,
      outsideOrganizer,
    ]) {
      await expect(service.setProfilePhoto(actor, profileId, headshot.id, 3)).rejects.toThrow();
      await expect(service.clearProfilePhoto(actor, profileId, 3)).rejects.toThrow();
    }
    await expect(
      service.setProfilePhoto(organizer, "00000000-0000-4000-8000-0000000000ff", headshot.id, 0),
    ).rejects.toThrow();
    // The refusals changed nothing.
    expect((await repository.findProfile(profileId))?.photoAssetId).toBe(headshot.id);

    // A slide deck is not a face. Reported against the field that named it, so the portal
    // can render the reason next to the control the speaker used.
    // ERROR-INTENT: the rejection is the assertion subject; it is inspected on the next lines.
    const refusedPdf = await service
      .setProfilePhoto(speaker, profileId, slides.id, 3)
      .catch((error) => error);
    expect(refusedPdf).toBeInstanceOf(SpeakerPhotoInvalidError);
    expect((refusedPdf as SpeakerPhotoInvalidError).fields.assetId?.[0]).toMatch(/not an image/);

    // Somebody else's upload, and an id that does not exist, are refused identically.
    const otherProfile = "10000000-0000-4000-8000-00000000000b";
    await repository.addProfile({
      id: otherProfile,
      eventId,
      userId: "other-user",
      sourcePersonId: "crm-email:other@example.test",
      name: "Other Speaker",
      email: "other@example.test",
      bio: "",
      pronouns: "",
      organization: "",
    });
    for (const assetId of [headshot.id, "00000000-0000-4000-8000-0000000000fe"]) {
      // ERROR-INTENT: the rejection is the assertion subject; it is inspected below.
      const refused = await service
        .setProfilePhoto(organizer, otherProfile, assetId, 0)
        .catch((error) => error);
      expect(refused).toBeInstanceOf(SpeakerPhotoInvalidError);
      expect((refused as SpeakerPhotoInvalidError).fields.assetId?.[0]).toMatch(/uploaded/);
    }
    expect((await repository.findProfile(otherProfile))?.photoAssetId).toBeUndefined();

    // Removing the choice keeps the file: this is "not this picture", not "delete it".
    await expect(service.clearProfilePhoto(speaker, profileId, 3)).resolves.not.toHaveProperty(
      "photoAssetId",
    );
    expect(await repository.findAsset(headshot.id)).not.toBeNull();
  });

  it("shares one versioned canonical profile command between organizer and speaker", async () => {
    const profileUpdated = vi.fn(async () => undefined);
    const { service, repository } = setup({ profileAudit: { profileUpdated } });
    const organizer = await resolveSeededDemoActor("organizer");
    const speaker = await resolveSeededDemoActor("speaker");

    const organized = await service.updateProfile(organizer, samProfile.id, {
      expectedVersion: 0,
      name: "Sam Speaker",
      pronouns: "they/them",
      jobTitle: "Principal Engineer",
      organization: "Northwind",
      bio: "Builds calm systems.",
      socialLinks: { website: "https://sam.example" },
    });
    expect(organized).toMatchObject({
      version: 1,
      jobTitle: "Principal Engineer",
      organization: "Northwind",
    });
    expect(profileUpdated).toHaveBeenLastCalledWith({
      actorId: organizer.id,
      actorName: organizer.name,
      source: "human",
      eventId,
      profileId: samProfile.id,
      version: 1,
    });

    // The portal form was opened at v0. It is refused rather than overwriting the organizer's
    // canonical edit, and a refusal creates neither a second revision nor an audit fact.
    await expect(
      service.updateProfile(speaker, samProfile.id, {
        expectedVersion: 0,
        name: "Stale Sam",
        pronouns: "",
        jobTitle: "",
        organization: "",
        bio: "stale",
      }),
    ).rejects.toBeInstanceOf(ContentConflictError);
    expect(await repository.findProfile(samProfile.id)).toMatchObject({
      name: "Sam Speaker",
      version: 1,
    });
    expect(profileUpdated).toHaveBeenCalledTimes(1);

    await expect(
      service.updateProfile(speaker, samProfile.id, {
        expectedVersion: 1,
        name: "Sam Speaker",
        pronouns: "they/them",
        jobTitle: "Principal Engineer",
        organization: "Northwind",
        bio: "Builds calm, accessible systems.",
      }),
    ).resolves.toMatchObject({
      version: 2,
      bio: "Builds calm, accessible systems.",
    });
    expect(profileUpdated).toHaveBeenLastCalledWith({
      actorId: speaker.id,
      actorName: speaker.name,
      source: "human",
      eventId,
      profileId: samProfile.id,
      version: 2,
    });
  });

  it("limits profile collaborators to the profiles and access level explicitly granted", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const collaborator: Actor = {
      ...(await resolveSeededDemoActor("speaker")),
      id: "agency-collaborator",
      name: "Agency Collaborator",
      capabilities: new Set(),
      eventAccess: [],
    };
    await service.setProfileCollaborators(organizer, samProfile.id, [
      { userId: collaborator.id, access: "view" },
    ]);

    await expect(service.workspace(collaborator, eventId)).resolves.toMatchObject({
      speakers: [{ id: samProfile.id }],
    });
    await expect(
      service.updateProfile(collaborator, samProfile.id, {
        expectedVersion: 0,
        name: "Agency edit",
        pronouns: "",
        jobTitle: "",
        organization: "",
        bio: "",
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);

    await service.setProfileCollaborators(organizer, samProfile.id, [
      { userId: collaborator.id, access: "edit" },
    ]);
    await expect(
      service.updateProfile(collaborator, samProfile.id, {
        expectedVersion: 0,
        name: "Agency edit",
        pronouns: "",
        jobTitle: "",
        organization: "",
        bio: "",
      }),
    ).resolves.toMatchObject({ name: "Agency edit", version: 1 });
  });

  it("retires a replaced or removed headshot from public visibility", async () => {
    const { service, repository } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const speaker = await resolveSeededDemoActor("speaker");
    const upload = (name: string) =>
      service.upload(speaker, {
        profileId: samProfile.id,
        name,
        contentType: "image/png",
        bytes: new Uint8Array([9]),
      });
    const first = await upload("first.png");
    const second = await upload("second.png");
    await service.publishAsset(organizer, first.id);
    await service.setProfilePhoto(speaker, samProfile.id, first.id, 0);
    expect((await repository.findAsset(first.id))?.visibility).toBe("publishable");

    await service.setProfilePhoto(organizer, samProfile.id, second.id, 1);
    expect((await repository.findAsset(first.id))?.visibility).toBe("private");
    expect(await service.readAsset(null, first.id)).toBeNull();
    expect((await repository.findAsset(second.id))?.visibility).toBe("private");

    await service.publishAsset(organizer, second.id);
    await service.clearProfilePhoto(organizer, samProfile.id, 2);
    expect((await repository.findAsset(second.id))?.visibility).toBe("private");
    expect(await service.readAsset(null, second.id)).toBeNull();
  });

  it("clears a headshot chosen through the portal when its file is deleted", async () => {
    const { service, repository, publishedEvents } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const speaker = await resolveSeededDemoActor("speaker");
    await service.accept(organizer, command, correlationId);
    const profileId = (await service.workspace(speaker, eventId)).speakers[0]?.id as string;
    const headshot = await service.upload(speaker, {
      profileId,
      name: "headshot.png",
      contentType: "image/png",
      bytes: new Uint8Array([4]),
    });
    await service.setProfilePhoto(speaker, profileId, headshot.id, 0);
    await service.publishAsset(organizer, headshot.id);
    await service.updateProfile(speaker, profileId, {
      expectedVersion: 1,
      name: "Sam Speaker",
      bio: "A revision whose snapshot still names the headshot.",
      pronouns: "",
      organization: "",
    });
    const photoRevision = ((await service.workspace(organizer, eventId)).revisions ?? []).find(
      (revision) =>
        revision.entityType === "profile" &&
        (JSON.parse(revision.snapshotJson) as SpeakerProfile).photoAssetId === headshot.id,
    );
    expect(photoRevision).toBeTruthy();
    expect(publishedEvents.has(eventId)).toBe(true);
    await expect(service.readAsset(null, headshot.id)).resolves.toMatchObject({
      publiclyReadable: true,
    });

    // Deleting the file must take the profile's pointer with it, or the next publish would
    // advertise a `photoUrl` that 404s. This is the same clearing the delete path always did,
    // now reached from a photo a speaker actually chose rather than one the seed wrote.
    await service.deleteAsset(speaker, headshot.id);
    expect((await repository.findProfile(profileId))?.photoAssetId).toBeUndefined();
    expect(await service.readAsset(organizer, headshot.id)).toBeNull();

    // Restoring a snapshot that named the now-deleted file restores the text but cannot
    // resurrect a dangling photo reference.
    await service.restoreRevision(organizer, photoRevision?.id ?? "");
    expect((await repository.findProfile(profileId))?.photoAssetId).toBeUndefined();
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
      override async replaceLatestAsset(): Promise<never> {
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
      agenda: agendaService(new MemoryAgendaRepository()),
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
    ).resolves.toMatchObject({
      title: "Updated session",
      publicationState: "ready",
    });
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
    await service.recordMessage(organizer, {
      profileId,
      subject: "Preparation reminder sent",
    });
    const workspace = await service.workspace(organizer, eventId);
    expect(workspace.tasks.map(({ title }) => title)).toContain("Upload final slides");
    expect(workspace.messages.map(({ subject }) => subject)).toContain("Preparation reminder sent");
  });
  it("emits a complete RFC 5545 document for the speaker's scheduled sessions", async () => {
    const service = calendarService([session()]);
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
  it("gives a speaker only their own sessions, never another speaker's", async () => {
    // The calendar is scoped by the reading actor, not by the event: a speaker's whereabouts —
    // which room, which hour — is not something a co-speaker is entitled to read off an export.
    const service = calendarService(
      [session(), session({ id: "session-2", speakerProfileIds: ["profile-other"] })],
      [
        openingPlacement,
        {
          sessionId: "session-2",
          startsAt: "2026-09-16T09:00:00.000Z",
          endsAt: "2026-09-16T10:00:00.000Z",
          location: "Side room",
        },
      ],
    );
    const document = (await service.calendar(
      await resolveSeededDemoActor("speaker"),
      eventId,
    )) as string;
    expect(document).toContain("UID:session-1@greenroom");
    expect(document).not.toContain("session-2@greenroom");
    expect(document).not.toContain("Side room");
  });
  it("escapes TEXT values and drops characters RFC 5545 cannot carry", async () => {
    const service = calendarService([
      session({ title: "Back\\slash, semi; colon\r\nsecondline\tkept" }),
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
    const service = calendarService([session({ title })]);
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
    const service = calendarService(
      [
        session({ id: "session-a", title: "Instant" }),
        session({ id: "session-b", title: "Unscheduled" }),
        session({ id: "session-c", title: "Unusable start" }),
      ],
      [
        // DTEND must be later than DTSTART, and a room with no name is not worth a LOCATION.
        {
          sessionId: "session-a",
          startsAt: "2026-09-15T17:00:00.000Z",
          endsAt: "2026-09-15T17:00:00.000Z",
          location: "",
        },
        // `session-b` is deliberately absent: the published agenda does not place it.
        {
          sessionId: "session-c",
          startsAt: "2026-09-15T17:00:00",
          endsAt: "",
          location: "",
        },
      ],
    );
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
    // RFC 5545 section 3.4: `icalbody = calprops component` with `component = 1*(...)`. A
    // VCALENDAR carrying only calprops is not an iCalendar object, and Apple and Google both
    // refuse to import one, so nothing is produced rather than something unusable.
    expect(await calendarService([]).calendar(speaker, eventId)).toBeNull();
    // A session the published agenda does not place has no time to export. Nothing invents one.
    expect(await calendarService([session()], []).calendar(speaker, eventId)).toBeNull();
    expect(
      await calendarService(
        [session()],
        [
          {
            sessionId: "session-1",
            startsAt: "not-a-date",
            endsAt: "",
            location: "",
          },
        ],
      ).calendar(speaker, eventId),
    ).toBeNull();
    // A zone-less local time cannot be expressed as a UTC DATE-TIME either.
    expect(
      await calendarService(
        [session()],
        [
          {
            sessionId: "session-1",
            startsAt: "2026-09-15T17:00:00",
            endsAt: "",
            location: "",
          },
        ],
      ).calendar(speaker, eventId),
    ).toBeNull();
  });
  it("stamps DTSTAMP from the injected clock and stays byte-for-byte deterministic", async () => {
    const speaker = await resolveSeededDemoActor("speaker");
    const service = calendarService([session()]);
    const first = (await service.calendar(speaker, eventId)) as string;
    expect(await service.calendar(speaker, eventId)).toBe(first);
    expect(calendarLines(first)).toContain("DTSTAMP:20260810T120000Z");
    const later = calendarService(
      [session()],
      [openingPlacement],
      () => new Date("2026-08-11T09:30:15.500Z"),
    );
    expect(calendarLines((await later.calendar(speaker, eventId)) as string)).toContain(
      "DTSTAMP:20260811T093015Z",
    );
  });

  /*
   * The agenda is the only place a session's time comes from.
   *
   * `content_sessions` used to carry `schedule_starts_at/ends_at/location`, written by nothing
   * but the demo seed: the speaker portal and this .ics answered 15 September while the agenda
   * board, the published schedule and the public event page all said 1 September, and moving
   * the session on the board left the download byte-identical. These two hold the fix in place.
   */
  it("takes a session's time and room from the agenda publication in force", async () => {
    const speaker = await resolveSeededDemoActor("speaker");
    const agendaRepository = new MemoryAgendaRepository();
    const repository = new MemoryContentRepository({
      sessions: [session({ title: "Designing the calm conference" })],
      speakers: [calendarSpeaker],
      tasks: [],
      assets: [],
      messages: [],
    });
    const service = new ContentService({
      repository,
      assetStorage: new DeterministicAssetStorage(),
      proposals: new FakeAcceptedProposals([]),
      agenda: agendaService(agendaRepository),
      speakerConversion: new MemorySpeakerConversion(repository, crypto.randomUUID),
      newId: crypto.randomUUID,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    // Nothing is published yet, so the session has no time at all — not a stale one.
    expect((await service.workspace(speaker, eventId)).sessions[0]?.schedule).toBeUndefined();
    expect(await service.calendar(speaker, eventId)).toBeNull();

    await agendaRepository.publish(
      publishedAgenda([
        {
          sessionId: "session-1",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
          location: "Main stage",
        },
      ]),
    );
    expect((await service.workspace(speaker, eventId)).sessions[0]?.schedule).toEqual({
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
      location: "Main stage",
    });
    expect(calendarLines((await service.calendar(speaker, eventId)) as string)).toEqual(
      expect.arrayContaining(["DTSTART:20260901T160000Z", "LOCATION:Main stage"]),
    );

    // Move the session and publish the schedule again: the portal and the download follow it.
    await agendaRepository.publish(
      publishedAgenda(
        [
          {
            sessionId: "session-1",
            startsAt: "2026-09-01T17:00:00.000Z",
            endsAt: "2026-09-01T18:00:00.000Z",
            location: "Workshop lab",
          },
        ],
        2,
      ),
    );
    expect((await service.workspace(speaker, eventId)).sessions[0]?.schedule).toEqual({
      startsAt: "2026-09-01T17:00:00.000Z",
      endsAt: "2026-09-01T18:00:00.000Z",
      location: "Workshop lab",
    });
    expect(calendarLines((await service.calendar(speaker, eventId)) as string)).toEqual(
      expect.arrayContaining(["DTSTART:20260901T170000Z", "LOCATION:Workshop lab"]),
    );
  });

  it("withdraws a session from the programme and takes its agenda placements with it", async () => {
    const draft = {
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
    };
    const { service, repository, agendaRepository } = setup({
      drafts: [draft],
    });
    const organizer = await resolveSeededDemoActor("organizer");
    const accepted = await service.accept(organizer, command, correlationId);
    const sessionId = accepted.sessions[0]?.id ?? "";
    await agendaRepository.savePlacement(eventId, {
      id: "placement-opening",
      sessionId,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    });

    // A speaker cannot withdraw a session, and neither can an organizer of another event.
    await expect(
      service.withdrawSession(await resolveSeededDemoActor("speaker"), sessionId),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      service.withdrawSession({ ...organizer, eventAccess: [] }, sessionId),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(await repository.findSession(sessionId)).not.toBeNull();

    const after = await service.withdrawSession(organizer, sessionId);
    expect(after.sessions).toHaveLength(0);
    expect(await repository.findSession(sessionId)).toBeNull();
    // The board no longer holds a slot for a session that no longer exists.
    expect((await agendaRepository.getDraft(eventId))?.placements).toEqual([]);
    // The speaker, their onboarding tasks and their uploads survive: they may be speaking
    // elsewhere, and one withdrawn talk is not a reason to delete a person's work.
    expect(after.speakers).toHaveLength(1);
    expect(after.tasks).toHaveLength(2);
  });
});

describe("what a lifecycle action asks to have sent (issue #66)", () => {
  /** Records every fact content reports, in order, without sending anything. */
  const recorder = () => {
    const accepted: Parameters<SpeakerNotificationPort["speakerAccepted"]>[0][] = [];
    const tasks: Parameters<SpeakerNotificationPort["taskAssigned"]>[0][] = [];
    return {
      accepted,
      tasks,
      port: {
        async speakerAccepted(fact) {
          accepted.push(fact);
        },
        async taskAssigned(fact) {
          tasks.push(fact);
        },
      } satisfies SpeakerNotificationPort,
    };
  };

  it("reports the accepted speaker with the address they can actually be reached at", async () => {
    const notifications = recorder();
    const { service } = setup({
      seedSpeaker: false,
      speakerNotifications: notifications.port,
    });
    const organizer = await resolveSeededDemoActor("organizer");

    await service.accept(organizer, command, correlationId);

    // Before #66 this was the gap: acceptance wrote a session and told the speaker nothing. The
    // address is the profile's, resolved server-side, not anything a client named.
    expect(notifications.accepted).toHaveLength(1);
    expect(notifications.accepted[0]).toMatchObject({
      eventId,
      speakerName: "Sam Speaker",
      speakerEmail: "sam@example.test",
    });
  });

  /**
   * The invitation is announced before the work it explains, and this is the test that pins it.
   *
   * Issue #207 collapsed all three announcements into one `Promise.all` for the five round trips
   * it saved. Review found the cost: a delivery's `created_at` is stamped inside its own enqueue
   * and the sender claims deliveries ordered on exactly that column, so three chains in flight
   * together are stamped in completion order and a speaker could be told to upload a headshot
   * before being told they had been accepted.
   *
   * Asserted on the **order of the calls** rather than on stored timestamps, deliberately: every
   * fixture in this repository freezes the clock, so four deliveries share one `created_at` and a
   * timestamp assertion would pass against the very arrangement it is meant to refuse. The call
   * order is the property the fix actually establishes.
   *
   * Re-collapse the two awaits in `acceptSession` into one `Promise.all` and this fails.
   */
  it("announces the acceptance before the work it explains", async () => {
    const order: string[] = [];
    const { service } = setup({
      seedSpeaker: false,
      speakerNotifications: {
        async speakerAccepted() {
          order.push("accepted");
          // Yields, so a `Promise.all` over all three would interleave here and let a task
          // notice reach the sink first. Without it the collapsed form passes by accident.
          await Promise.resolve();
          order.push("accepted:done");
        },
        async taskAssigned(fact) {
          order.push(`task:${fact.taskTitle}`);
        },
      },
    });
    const organizer = await resolveSeededDemoActor("organizer");

    await service.accept(organizer, command, correlationId);

    // The invitation's chain completes before either task notice starts. Asserted as a boundary
    // rather than as an exact array, because `acceptSession` says outright that nothing orders
    // the two task notices against each other — pinning them here would refuse a change the
    // design calls meaningless, and fail pointing at acceptance ordering.
    expect(order.slice(0, 2)).toEqual(["accepted", "accepted:done"]);
    expect(order.slice(2).toSorted()).toEqual([
      "task:Complete your speaker profile",
      "task:Upload a headshot",
    ]);
  });

  it("reports each onboarding task acceptance created, so the checklist is not silent", async () => {
    const notifications = recorder();
    const { service } = setup({
      seedSpeaker: false,
      speakerNotifications: notifications.port,
    });
    const organizer = await resolveSeededDemoActor("organizer");

    await service.accept(organizer, command, correlationId);

    expect(notifications.tasks.map(({ taskTitle }) => taskTitle)).toEqual([
      "Complete your speaker profile",
      "Upload a headshot",
    ]);
    // Keyed on the task, so the delivering domain dedupes per task rather than per speaker.
    expect(new Set(notifications.tasks.map(({ taskId }) => taskId)).size).toBe(2);
  });

  it("says nothing the second time the same proposal is accepted", async () => {
    const notifications = recorder();
    const { service } = setup({
      seedSpeaker: false,
      speakerNotifications: notifications.port,
    });
    const organizer = await resolveSeededDemoActor("organizer");

    await service.accept(organizer, command, correlationId);
    await service.accept(organizer, command, correlationId);

    // Re-accepting is the same acceptance. The delivering domain deduplicates it too, but not
    // announcing it twice is what keeps the two mechanisms from hiding each other's bugs.
    expect(notifications.accepted).toHaveLength(1);
    expect(notifications.tasks).toHaveLength(2);
  });

  it("reports a task an organizer requests by hand", async () => {
    const notifications = recorder();
    const { service } = setup({ speakerNotifications: notifications.port });
    const organizer = await resolveSeededDemoActor("organizer");

    const task = await service.requestTask(organizer, {
      profileId: samProfile.id,
      title: "Send your slides",
      dueAt: "2026-09-01T00:00:00.000Z",
    });

    expect(notifications.tasks).toEqual([
      {
        eventId,
        profileId: samProfile.id,
        taskId: task.id,
        speakerName: "Sam Speaker",
        speakerEmail: "sam@example.test",
        taskTitle: "Send your slides",
        dueAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("still accepts when there is nobody bound to tell", async () => {
    // The port is optional and content works exactly as it did before #66 without one: a
    // composition that cannot send must not be a composition that cannot accept.
    const { service } = setup({ seedSpeaker: false });
    const organizer = await resolveSeededDemoActor("organizer");

    const workspace = await service.accept(organizer, command, correlationId);

    expect(workspace.sessions).toHaveLength(1);
  });
});

/**
 * The console's authoring path for the event's speaker checklist (issue #176).
 *
 * `importTaskTemplates` writes at `(event_id, title)`, which is right for a clone and wrong for
 * a person: it cannot rename a line and cannot remove one. These three commands are what the
 * console actually uses, and what they refuse matters as much as what they write.
 */
describe("speaker checklist authoring", () => {
  const line = {
    title: "Upload a headshot",
    description: "Square, at least 800px.",
    sortOrder: 0,
    dueOffsetDays: -30,
  };

  it("adds a line, edits it including its title, and removes it", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");

    const created = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });
    expect(await service.taskTemplates(organizer, eventId)).toMatchObject([{ title: line.title }]);

    /*
     * The rename is the whole reason this command exists. Through the import path the corrected
     * title would write a *second* line and leave the mistyped one behind for ever, since
     * nothing there removes anything.
     */
    await service.updateTaskTemplate(organizer, created.id, {
      ...line,
      title: "Upload a portrait",
      dueOffsetDays: -21,
    });
    expect(await service.taskTemplates(organizer, eventId)).toMatchObject([
      { id: created.id, title: "Upload a portrait", dueOffsetDays: -21 },
    ]);

    await service.deleteTaskTemplate(organizer, created.id);
    expect(await service.taskTemplates(organizer, eventId)).toEqual([]);
  });

  it("refuses a title another line already holds rather than overwriting it", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.createTaskTemplate(organizer, { eventId, ...line });
    const second = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
      title: "Send slides",
      sortOrder: 1,
    });

    // Converging here — which is what the import path does — would replace a line the organizer
    // can still see on the screen in front of them with the one they are typing.
    await expect(
      service.createTaskTemplate(organizer, { eventId, ...line }),
    ).rejects.toBeInstanceOf(SpeakerChecklistTitleTakenError);
    await expect(
      service.updateTaskTemplate(organizer, second.id, {
        ...line,
        sortOrder: 1,
      }),
    ).rejects.toBeInstanceOf(SpeakerChecklistTitleTakenError);
    expect(await service.taskTemplates(organizer, eventId)).toHaveLength(2);
  });

  /**
   * Instantiating the checklist tells the speakers, and `PRD-SPK-002` says so.
   *
   * The specification's own sentence a paragraph later — "these records create no notification or
   * delivery effect" — is about the *content records* it lists there, not about this command; the
   * distinction is the difference between recording a message and asking for one to be sent. A
   * claim in a normative document with no assertion behind it is how the two drift, so this pins
   * it: one notification per task actually created, and none for a line the speaker already held.
   */
  it("tells each speaker about the work this assignment created, and only that", async () => {
    const told: Parameters<SpeakerNotificationPort["taskAssigned"]>[0][] = [];
    const { service } = setup({
      speakerNotifications: {
        async speakerAccepted(fact) {
          // Recorded rather than ignored: this test asserts what was told *and* what was not, so
          // an acceptance leaking into this path has to be visible rather than swallowed.
          told.push({
            ...fact,
            taskId: "unexpected-acceptance",
            taskTitle: "",
            dueAt: "",
          });
        },
        async taskAssigned(fact) {
          told.push(fact);
        },
      },
    });
    const organizer = await resolveSeededDemoActor("organizer");
    await service.createTaskTemplate(organizer, { eventId, ...line });
    await service.assignTaskChecklist(organizer, {
      eventId,
      profileIds: [samProfile.id],
    });

    expect(told).toMatchObject([
      {
        eventId,
        profileId: samProfile.id,
        speakerName: "Sam Speaker",
        taskTitle: line.title,
      },
    ]);

    // Idempotent, and so is the telling: a second run assigns nothing and announces nothing,
    // which is what makes "run it again when somebody joins" safe rather than a way to nag.
    await service.assignTaskChecklist(organizer, {
      eventId,
      profileIds: [samProfile.id],
    });
    expect(told).toHaveLength(1);
  });

  it("keeps the declaration date through an edit", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const created = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });

    await service.updateTaskTemplate(organizer, created.id, {
      ...line,
      description: "800px.",
    });

    // A line was declared when it was declared; rewording it is not a new declaration.
    expect((await service.taskTemplates(organizer, eventId))[0]?.createdAt).toBe(created.createdAt);
  });

  it("leaves work already assigned from a line alone when the line goes", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const created = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });
    await service.assignTaskChecklist(organizer, {
      eventId,
      profileIds: [samProfile.id],
    });

    await service.deleteTaskTemplate(organizer, created.id);

    /*
     * `speaker_tasks` holds no pointer back to the line, deliberately: once assigned, the work
     * is that speaker's. Deleting a line an organizer has stopped asking for must not delete
     * the homework of everybody who was already asked for it.
     */
    const workspace = await service.workspace(organizer, eventId);
    expect(workspace.tasks.map(({ title }) => title)).toEqual([line.title]);
  });

  it("refuses a line to an actor who does not administer its event, as one that does not exist", async () => {
    const { service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const created = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });
    const speaker = await resolveSeededDemoActor("speaker");

    await expect(
      service.createTaskTemplate(speaker, {
        eventId,
        ...line,
        title: "Something else",
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(service.updateTaskTemplate(speaker, created.id, line)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    await expect(service.deleteTaskTemplate(speaker, created.id)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // The same refusal for an id that names nothing, so this is not an existence oracle either.
    await expect(
      service.deleteTaskTemplate(organizer, "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(await service.taskTemplates(organizer, eventId)).toHaveLength(1);
  });

  /**
   * A write that matched no row is refused, rather than announced as a save.
   *
   * Three writers a caller reads a row for first — a checklist line, a portal resource, a
   * speaker's task — have the same gap between that read and the write, and it is where another
   * organizer's delete lands. `success` alone cannot tell "rewrote the row" from "matched
   * nothing", so before the affected-row count was read these answered 200 and reported a save
   * over a projection that no longer contains the thing.
   *
   * The four *other* writers this comment used to name as still unguarded are closed by issue
   * #202: `updateProfilePhoto`, `updateProfileWorkflow`, `updateAsset` and
   * `completeSpeakerImport` all read the count now, and their evidence lives in
   * `d1-content-repository.integration.test.ts` and `content-csv-import.test.ts` — against real
   * D1 for the three storage writers, because a row deleted out from under a caller is the
   * subject and a memory repository has no row count to report.
   */
  it("refuses an edit to a line, a resource or a task that has gone since it was read", async () => {
    const { repository, service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const created = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });

    // The row goes out from under its caller between the read and the write.
    await repository.deleteTaskTemplate(created.id);

    await expect(
      service.updateTaskTemplate(organizer, created.id, {
        ...line,
        description: "Changed",
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);

    /*
     * The same rule at the store, for the two writers that reach it the same way. Asserted here
     * rather than through their services because the point is the contract every one of them now
     * shares: a matched row is what makes an update an update.
     */
    await expect(
      repository.updateResource({
        id: "00000000-0000-4000-8000-00000000ff01",
        eventId,
        title: "Gone",
        slug: "gone",
        bodyHtml: "",
        embedHtml: "",
        visibility: "hidden",
        sortOrder: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.updateTask({
        id: "00000000-0000-4000-8000-00000000ff02",
        eventId,
        speakerProfileId: samProfile.id,
        title: "Gone",
        dueAt: "2026-09-01T00:00:00.000Z",
        status: "complete",
      }),
    ).resolves.toBe(false);
  });

  /**
   * A line on an event this organizer does not administer, refused as one that does not exist.
   *
   * This is the **whole** authorization on `PATCH` and `DELETE /api/speaker-task-templates/:id`.
   * Neither route carries a capability check of its own, deliberately: they take no event
   * parameter, so the event is resolved from the stored row and `requireTaskTemplate` is the only
   * thing between a caller and another organization's checklist. A route whose entire
   * authorization is one service call needs that call asserted — and so does the byte-identical
   * refusal both route comments claim, or "not an oracle for other organizations' ids" is a
   * sentence rather than a behaviour.
   */
  it("refuses another event's line exactly as it refuses one that does not exist", async () => {
    const { repository, service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    // Written straight to the store: the point is a row this actor cannot reach, and the command
    // that would create one refuses for the same reason this test is about.
    const elsewhere = {
      id: "00000000-0000-4000-8000-0000000000e1",
      eventId: "00000000-0000-4000-8000-0000000000e0",
      title: "Somebody else's line",
      description: "",
      sortOrder: 0,
      dueOffsetDays: -7,
      createdAt: "2026-08-10T12:00:00.000Z",
    };
    await repository.addTaskTemplate(elsewhere);
    const unknown = "00000000-0000-4000-8000-0000000000e2";

    /**
     * The refusal a call raised, as a value.
     *
     * ERROR-INTENT: the refusals are this test's subject rather than an incident in it, and they
     * are compared with *each other* — a `rejects` matcher per call asserts each alone and says
     * nothing about the property under test, which is that all four are indistinguishable. Every
     * captured value is asserted below, and a call that does not refuse fails on the first
     * assertion rather than passing quietly.
     */
    const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
      try {
        await work;
        return "no refusal was raised";
      } catch (refusal) {
        // ERROR-INTENT: returned to the caller, which asserts on it. Nothing is discarded — this
        // is the value the whole test compares, and a call that raised nothing is reported as
        // such above rather than silently reading as a refusal.
        return refusal;
      }
    };
    const refusals = await Promise.all(
      [elsewhere.id, unknown].flatMap((id) => [
        refusalOf(
          service.updateTaskTemplate(organizer, id, {
            ...line,
            title: "Renamed",
          }),
        ),
        refusalOf(service.deleteTaskTemplate(organizer, id)),
      ]),
    );

    /*
     * Four refusals of one type. The *messages* differ — "no such line" comes from the row read,
     * "not yours" from the capability check — and that is fine precisely because they never
     * travel: `transport/http/app.ts` answers every `CapabilityDeniedError` with one 403 and one
     * sentence. Asserting the messages equal here would pin an internal detail; the property that
     * matters is observable, so it is asserted where a caller stands, in `content-http.test.ts`.
     */
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(CapabilityDeniedError);
    // And nothing was written to the other event's checklist on the way past.
    await expect(repository.findTaskTemplate(elsewhere.id)).resolves.toEqual(elsewhere);
  });

  /**
   * The **store** resolves existence before the title rule, which is the order D1 resolves them in.
   *
   * Driven straight at the repository, and that is the whole point: the service reads the row
   * first, so a vanished line never reaches the write at all and a test that went through
   * `updateTaskTemplate` would assert the service's read order while claiming to assert the
   * store's. This renames a *vanished* line onto a title a **sibling** still holds — the one
   * shape the two orderings disagree about. A double that checked the title first throws "that
   * title is taken" about a row that is not there; D1 matches nothing and answers `false`, and a
   * service test written against the permissive double would pass through the wrong refusal.
   */
  it("answers a vanished line as gone rather than as a duplicate title", async () => {
    const { repository, service } = setup();
    const organizer = await resolveSeededDemoActor("organizer");
    const survivor = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
    });
    const doomed = await service.createTaskTemplate(organizer, {
      eventId,
      ...line,
      title: "Send your slides",
      sortOrder: 1,
    });
    await repository.deleteTaskTemplate(doomed.id);

    await expect(repository.updateTaskTemplate({ ...doomed, title: survivor.title })).resolves.toBe(
      false,
    );
    // And through the service, where the read refuses before the write is reached at all.
    await expect(
      service.updateTaskTemplate(organizer, doomed.id, {
        ...line,
        title: survivor.title,
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
