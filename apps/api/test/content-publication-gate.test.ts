// @acceptance ACC-SPEAKER

/**
 * The gate between the organizer's workspace and everything the public may see.
 *
 * `publishedEventContent` is content's public application interface — the only way the publishing
 * domain reads sessions, speakers and assets (`ARC-FLOW-003`), and therefore the single place
 * where "not approved yet" has to mean "not visible". Publishing composes a snapshot from
 * whatever this returns, so anything that leaks here is already on the public page by the time
 * anybody notices. These drive the state through `ContentService` and read the gate's answer
 * (#189).
 */

import { describe, expect, it } from "vitest";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import type { Actor } from "../src/application/identity/actor";
import type {
  ContentSession,
  PublicationState,
  SpeakerProfile,
} from "../src/domain/content/content";

const eventId = "00000000-0000-4000-8000-000000000001";
const samProfileId = "10000000-0000-4000-8000-000000000001";
const adaProfileId = "10000000-0000-4000-8000-000000000002";
const approvedSessionId = "20000000-0000-4000-8000-000000000001";
const unapprovedSessionId = "20000000-0000-4000-8000-000000000002";

const speakerActor = (id: string): Actor => ({
  id,
  name: id,
  persona: "speaker",
  organizations: [],
  capabilities: new Set(["content:read"]),
  eventAccess: [{ eventId, role: "speaker", capabilities: new Set(["content:read"]) }],
});
const sam = speakerActor("sam-user");
const ada = speakerActor("ada-user");
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
  bio: `${name} builds things`,
  pronouns: "they/them",
  jobTitle: "Engineering Director",
  organization: "Greenroom Labs",
});

const session = (id: string, title: string, speakerProfileIds: string[]): ContentSession => ({
  id,
  eventId,
  proposalId: `proposal-${id}`,
  title,
  abstract: `About ${title}`,
  format: "Talk",
  speakerProfileIds,
  tags: ["ops"],
  tracks: ["platform"],
  publicationState: "draft",
});

function fixture() {
  const repository = new MemoryContentRepository({
    sessions: [
      session(approvedSessionId, "Calm systems", [samProfileId]),
      session(unapprovedSessionId, "Zero downtime", [adaProfileId]),
    ],
    speakers: [profile(samProfileId, sam.id, "Sam"), profile(adaProfileId, ada.id, "Ada")],
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
    speakerConversion: { createOrLink: async () => ({ speakerId: samProfileId }) },
    newId: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });

  /** The organizer's approval, made the way the console makes it. */
  const setState = async (
    sessionId: string,
    publicationState: PublicationState,
    speakerProfileIds?: string[],
  ) => {
    const current = await repository.findSession(sessionId);
    if (!current) throw new Error(`Seeded session ${sessionId} is missing`);
    return service.updateSession(organizer, sessionId, {
      title: current.title,
      abstract: current.abstract,
      format: current.format,
      speakerProfileIds: speakerProfileIds ?? [...current.speakerProfileIds],
      tags: [...current.tags],
      tracks: [...current.tracks],
      publicationState,
    });
  };

  const upload = (actor: Actor, profileId: string, name: string, contentType: string) =>
    service.upload(actor, { profileId, name, contentType, bytes: new Uint8Array([1]) });

  return { repository, service, setState, upload };
}

describe("public projection gate", () => {
  it("withholds an unapproved session, the speaker only it carries, and every private asset", async () => {
    const { repository, service, setState, upload } = fixture();
    const headshot = await upload(sam, samProfileId, "sam.png", "image/png");
    await upload(sam, samProfileId, "slides.pdf", "application/pdf");
    const adaHeadshot = await upload(ada, adaProfileId, "ada.png", "image/png");
    // Two deliberate publication decisions, on two speakers, one of whom is not in the programme.
    await service.publishAsset(organizer, headshot.id);
    await service.publishAsset(organizer, adaHeadshot.id);
    await setState(approvedSessionId, "published");

    const published = await repository.publishedEventContent(eventId);

    expect(published.sessions.map(({ id }) => id)).toEqual([approvedSessionId]);
    // Ada is a real speaker with a published headshot, and still has no business on the public
    // page: the only session she appears on has not been approved, so publishing her name and
    // face would announce a talk the organizer has not agreed to run.
    expect(published.speakers.map(({ name }) => name)).toEqual(["Sam"]);
    expect(published.assets.map(({ name }) => name)).toEqual(["sam.png"]);
    // The speaker's own upload that nobody marked publishable, withheld from the same read that
    // the publishing snapshot is built from.
    expect(published.assets.map(({ id }) => id)).not.toContain(adaHeadshot.id);
  });

  it("carries no contact detail or organizer note into the projection", async () => {
    const { repository, service, setState } = fixture();
    await service.updateSpeakerWorkflow(organizer, samProfileId, {
      workflowStatus: "ready",
      logistics: { hotel: "Room 12, checked in" },
      customFields: { shirt: "M" },
    });
    await setState(approvedSessionId, "published");

    const [speaker] = (await repository.publishedEventContent(eventId)).speakers;

    // The projection is an allowlist of columns, not the profile row minus a few. A speaker's
    // address, their hotel room and whatever an organizer typed into a custom field are the
    // event's private working notes; the public page renders the bio, not the roster.
    expect(speaker).toEqual({
      id: samProfileId,
      name: "Sam",
      bio: "Sam builds things",
      pronouns: "they/them",
      jobTitle: "Engineering Director",
      organization: "Greenroom Labs",
    });
  });

  it("treats every state but published as unapproved, ready included", async () => {
    const { repository, setState } = fixture();
    await setState(approvedSessionId, "published");
    expect((await repository.publishedEventContent(eventId)).sessions).toHaveLength(1);

    // `ready` is "an organizer has finished with it", which is a step before the decision to
    // publish and not a quiet substitute for it. Un-approving has to take the session back out
    // along with the speaker it brought in, or "unpublish" is a button that changes nothing.
    await setState(approvedSessionId, "ready");

    expect(await repository.publishedEventContent(eventId)).toEqual({
      sessions: [],
      speakers: [],
      assets: [],
    });
  });

  it("withholds an unapproved session without withholding its speaker's approved one", async () => {
    const { repository, setState } = fixture();
    await setState(approvedSessionId, "published");
    // The organizer adds Sam to the draft talk as a co-speaker. The gate excludes sessions, not
    // people: Sam stays because of the talk that was approved, and the draft one stays hidden.
    await setState(unapprovedSessionId, "draft", [adaProfileId, samProfileId]);

    const published = await repository.publishedEventContent(eventId);

    expect(published.sessions.map(({ title }) => title)).toEqual(["Calm systems"]);
    expect(published.speakers.map(({ name }) => name)).toEqual(["Sam"]);
  });
});
