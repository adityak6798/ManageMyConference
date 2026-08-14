// @acceptance ACC-SPEAKER

/**
 * Session editing, and the history that makes it safe to do.
 *
 * An organizer retitles somebody else's talk two days before the conference. The product's answer
 * to "what did it say before?" is the revision the edit wrote, and the product's answer to "put it
 * back" is `restoreRevision`. Both existed with nothing asserting either: a revision recording the
 * *new* state instead of the state it replaced would look identical from the outside until the day
 * somebody needed the old title back and found two copies of the new one (#189).
 */

import { describe, expect, it } from "vitest";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import { type Actor, CapabilityDeniedError } from "../src/application/identity/actor";
import type { ContentSession, SpeakerProfile } from "../src/domain/content/content";

const eventId = "00000000-0000-4000-8000-000000000001";
const profileId = "10000000-0000-4000-8000-000000000001";
const coSpeakerProfileId = "10000000-0000-4000-8000-000000000002";
const sessionId = "20000000-0000-4000-8000-000000000001";

const speaker: Actor = {
  id: "sam-user",
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

const profile = (id: string, userId: string, name: string): SpeakerProfile => ({
  id,
  eventId,
  userId,
  sourcePersonId: `source-${name.toLowerCase()}`,
  name,
  email: `${name.toLowerCase()}@example.test`,
  bio: "",
  pronouns: "",
  organization: "",
});

/** What the session said when review handed it over, and what every restore below aims at. */
const original: ContentSession = {
  id: sessionId,
  eventId,
  proposalId: "proposal-1",
  title: "Calm systems",
  abstract: "The original abstract, as submitted.",
  format: "Talk",
  speakerProfileIds: [profileId],
  tags: ["ops"],
  tracks: ["platform"],
  publicationState: "draft",
};

const rewritten = {
  title: "Calm systems, revisited",
  abstract: "Rewritten by the organizer.",
  format: "Keynote",
  speakerProfileIds: [profileId, coSpeakerProfileId],
  tags: ["ops", "culture"],
  tracks: ["mainstage"],
  publicationState: "published",
} as const;

function fixture() {
  const repository = new MemoryContentRepository({
    sessions: [original],
    speakers: [
      profile(profileId, speaker.id, "Sam"),
      profile(coSpeakerProfileId, "ada-user", "Ada"),
    ],
    tasks: [],
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
      unscheduleSession: async () => undefined,
    },
    speakerConversion: { createOrLink: async () => ({ speakerId: profileId }) },
    newId: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  const history = async () => (await repository.workspace(eventId)).revisions ?? [];
  const readSession = async () => {
    const stored = await repository.findSession(sessionId);
    if (!stored) throw new Error("Seeded session is missing");
    return stored;
  };
  return { repository, service, history, readSession };
}

describe("session edits and their history", () => {
  it("records the state the edit replaced, not the state it wrote", async () => {
    const { service, history, readSession } = fixture();

    const updated = await service.updateSession(organizer, sessionId, { ...rewritten });

    expect(updated).toMatchObject(rewritten);
    expect(await readSession()).toMatchObject(rewritten);
    const revisions = await history();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      entityType: "session",
      entityId: sessionId,
      revisionNumber: 1,
      // Who changed it, because "what did it say before?" is only half of the question an
      // organizer asks when a talk they did not touch reads differently.
      actorId: organizer.id,
    });
    // The whole prior row, not a diff: a snapshot is what a restore reads, so anything it omits
    // is a field the restore cannot put back.
    expect(JSON.parse(revisions[0]?.snapshotJson ?? "null")).toEqual(original);
  });

  it("appends each edit's prior state rather than overwriting the last", async () => {
    const { service, history } = fixture();
    await service.updateSession(organizer, sessionId, { ...rewritten, title: "First rewrite" });
    await service.updateSession(organizer, sessionId, { ...rewritten, title: "Second rewrite" });

    const revisions = await history();

    // Two edits, two recoverable states: the one before anybody touched it and the one between.
    // A history that kept only the most recent prior state would make the original unreachable
    // the moment a second organizer edited the same session.
    expect(revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2]);
    expect(
      revisions.map(({ snapshotJson }) => (JSON.parse(snapshotJson) as ContentSession).title),
    ).toEqual(["Calm systems", "First rewrite"]);
  });

  it("restores the values the snapshot holds, and records the restore as an edit of its own", async () => {
    const { service, history, readSession } = fixture();
    await service.updateSession(organizer, sessionId, { ...rewritten });
    const [firstRevision] = await history();

    await service.restoreRevision(organizer, firstRevision?.id ?? "");

    expect(await readSession()).toEqual(original);
    const revisions = await history();
    // A restore is an edit like any other, so the state it replaced is recoverable too — an
    // organizer who restores the wrong revision is one more restore away from where they were,
    // rather than having overwritten the current text with no record of it.
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({
      revisionNumber: 2,
      restoredFromRevisionId: firstRevision?.id,
    });
    expect(JSON.parse(revisions[1]?.snapshotJson ?? "null")).toMatchObject({
      title: rewritten.title,
    });
  });

  it("does not resurrect a field no edit can write", async () => {
    const { repository, service, history, readSession } = fixture();
    await service.updateSession(organizer, sessionId, { ...rewritten });
    const [firstRevision] = await history();
    /*
     * `proposalId` is the session's link back to the abstract review accepted, and `id` and
     * `eventId` are its identity. No edit writes any of them, so a snapshot that happens to
     * carry an older value must not appear to put it back — a restore that spread the snapshot
     * wholesale would relink a session to a proposal, or move it to another event, through a
     * button labelled "restore". Rewritten out of band here because nothing in the service
     * offers a way to do it.
     */
    await repository.updateSession({ ...(await readSession()), proposalId: "proposal-relinked" });

    await service.restoreRevision(organizer, firstRevision?.id ?? "");

    expect(await readSession()).toMatchObject({
      id: sessionId,
      eventId,
      proposalId: "proposal-relinked",
      title: original.title,
    });
  });

  it("takes an approved session back off the public projection when the snapshot predates approval", async () => {
    const { repository, service, history } = fixture();
    await service.updateSession(organizer, sessionId, { ...rewritten });
    const [beforeApproval] = await history();
    expect((await repository.publishedEventContent(eventId)).sessions).toHaveLength(1);

    await service.restoreRevision(organizer, beforeApproval?.id ?? "");

    // `publicationState` is an edited field like the title, so restoring a draft-era revision is
    // a withdrawal from the public page and not merely a text change with the approval left on.
    expect(await repository.publishedEventContent(eventId)).toEqual({
      sessions: [],
      speakers: [],
      assets: [],
    });
  });

  it("refuses an edit and a restore from the speaker whose session it is", async () => {
    const { service, history } = fixture();
    await service.updateSession(organizer, sessionId, { ...rewritten });
    const [firstRevision] = await history();

    // Speakers edit their own profile, never the programme: a session's title, track and
    // approval are the organizer's, and a restore is a write like any other.
    await expect(
      service.updateSession(speaker, sessionId, { ...rewritten, title: "Mine now" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(service.restoreRevision(speaker, firstRevision?.id ?? "")).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    expect(await history()).toHaveLength(1);
  });
});
