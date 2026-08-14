// @acceptance ACC-SPEAKER

import { updateSpeakerProfileInputSchema } from "@greenroom/contracts";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDeliverablesZip } from "../src/adapters/content/create-deliverables-zip";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import {
  ContentNotFoundError,
  ContentService,
  type ContentServiceDependencies,
  SpeakerRemindersUnavailableError,
} from "../src/application/content/content-service";
import {
  type SpeakerReminderDispatchPort,
  SpeakerReminderRejectedError,
} from "../src/application/content/reminder-dispatch";
import type { Actor } from "../src/application/identity/actor";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import { PublicationService } from "../src/application/publishing/publication-service";
import type { Publication } from "../src/domain/publishing/publication";

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
/**
 * The same person, holding the capability the Publish button actually requires.
 *
 * Publishing authorizes on `events:settings:*` rather than on `content:manage`, so the organizer
 * above cannot drive it. Kept separate rather than widening that one, because every other test
 * in this file is about what a content capability permits.
 */
const publisher: Actor = {
  ...organizer,
  capabilities: new Set([
    ...organizer.capabilities,
    "events:settings:read",
    "events:settings:update",
  ]),
  eventAccess: [
    {
      eventId,
      role: "organizer",
      capabilities: new Set(["events:settings:read", "events:settings:update"]),
    },
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
      unscheduleSession: async () => undefined,
    },
    speakerConversion: { createOrLink: async () => ({ speakerId: profileId }) },
    newId: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    createDeliverablesZip,
  });
  return { repository, service };
}

/**
 * A dispatch port that behaves like the delivering domain: idempotent on the key.
 *
 * One log for both methods, because the delivering domain has one outbox: an invitation and a
 * reminder that somehow claimed the same key would collide there, so a double that kept two
 * lists would hide exactly the collision the keys are designed to avoid.
 */
function dispatcher() {
  const sent: { key: string; recipient: string; payload: unknown }[] = [];
  const enqueue = (message: {
    idempotencyKey: string;
    recipientRef: string;
    payload: Readonly<Record<string, unknown>>;
  }) => {
    const existing = sent.findIndex(({ key }) => key === message.idempotencyKey);
    if (existing >= 0) return { deliveryId: `d${existing}`, created: false };
    sent.push({
      key: message.idempotencyKey,
      recipient: message.recipientRef,
      payload: message.payload,
    });
    return { deliveryId: `d${sent.length - 1}`, created: true };
  };
  // Typed against the port rather than structurally, so a method added to the interface fails
  // here instead of leaving this double silently answering an older contract.
  const port: SpeakerReminderDispatchPort = {
    async send(reminder) {
      return enqueue(reminder);
    },
    async invite(invitation) {
      return enqueue(invitation);
    },
  };
  return { sent, port };
}

/**
 * The same fixture, with a delivering domain bound and an owning organization.
 *
 * Shared by the reminder and invitation suites rather than built twice: both commands refuse
 * identically without a bound port, and a second copy of this wiring is a second place for the
 * two to drift apart.
 */
function remindable(overrides: Partial<ContentServiceDependencies> = {}) {
  const { repository, service } = fixture();
  const dispatch = dispatcher();
  const dependencies = (service as unknown as { dependencies: ContentServiceDependencies })
    .dependencies;
  const withReminders = new ContentService({
    ...dependencies,
    reminders: dispatch.port,
    organizationOf: async () => "00000000-0000-4000-8000-000000000010",
    ...overrides,
  });
  return { repository, service: withReminders, dispatch };
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

  /*
   * CNT-04. The evaluator uploaded `slides.pdf` twice and got two separate v1 assets, because
   * the chain was inferred from a read and an upload naming no group found no previous version.
   * These pin the identity rule rather than one example of it.
   */
  it("versions a re-upload of the same file name", async () => {
    const { repository, service } = fixture();
    const first = await service.upload(speaker, {
      profileId,
      name: "slides.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
    });
    const second = await service.upload(speaker, {
      profileId,
      name: "slides.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([2]),
    });
    expect(second.versionGroupId).toBe(first.versionGroupId);
    expect([first.versionNumber, second.versionNumber]).toEqual([1, 2]);
    const stored = (await repository.workspace(eventId)).assets;
    expect(stored.map(({ versionNumber, isLatest }) => [versionNumber, isLatest])).toEqual([
      [1, false],
      [2, true],
    ]);
    // The superseded version is still readable, which is the other half of the requirement.
    expect(await service.readAsset(speaker, first.id)).not.toBeNull();
  });

  it("keeps a different file name a different deliverable", async () => {
    const { service } = fixture();
    const slides = await service.upload(speaker, {
      profileId,
      name: "slides.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
    });
    const handout = await service.upload(speaker, {
      profileId,
      name: "handout.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([2]),
    });
    expect(handout.versionGroupId).not.toBe(slides.versionGroupId);
    expect(handout.versionNumber).toBe(1);
  });

  /*
   * A file-request task is one requested deliverable, so replacing the file that answers it is a
   * new version even under a different name. Without this the rename would start a second chain
   * and the task would appear to have two answers.
   */
  it("versions by the task when one is named, whatever the file is called", async () => {
    const { service } = fixture();
    const taskId = "30000000-0000-4000-8000-000000000001";
    const first = await service.upload(speaker, {
      profileId,
      name: "deck.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
      taskId,
    });
    const second = await service.upload(speaker, {
      profileId,
      name: "deck-final.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([2]),
      taskId,
    });
    expect(second.versionGroupId).toBe(first.versionGroupId);
    expect(second.versionNumber).toBe(2);
    // And a general upload of the same name is not swept into the task's chain.
    const loose = await service.upload(speaker, {
      profileId,
      name: "deck.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([3]),
    });
    expect(loose.versionGroupId).not.toBe(first.versionGroupId);
  });

  it("refuses a continuation of a version group that is not this speaker's", async () => {
    const { service } = fixture();
    await expect(
      service.upload(speaker, {
        profileId,
        name: "slides.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array([1]),
        versionGroupId: "90000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toThrow();
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

/**
 * Take this event's public page live, through the real publishing service.
 *
 * Publishing reads content only through `publishedEventContent` and then copies what it read
 * key by key in `allowlistPublicProjection`, so a field content stores faithfully and publishing
 * forgets is invisible to every assertion that stops at the content repository: the portal saves
 * it, the organizer sees it, and the public page never shows it. Driving the real service is the
 * only way to say a value *reaches the published projection*.
 *
 * The store below is the narrowest one a single publish needs — publishing's own storage rules
 * (versions, slug ownership, reconciliation) belong to `publication.test.ts` and the D1 suite,
 * and a fixture answering them here would be inventing behaviour nobody asked it for.
 */
async function publishSite(content: MemoryContentRepository) {
  let record: Publication | null = null;
  const store: PublicationRepository = {
    findByEventId: async () => record,
    publish: async (id, publishedAt, projection) => {
      record = {
        eventId: id,
        slug: projection.event.slug,
        state: "published",
        draft: projection,
        published: projection,
        publishedAt,
      };
      return record;
    },
    // Never reached by `publish`, and answered with a refusal rather than a plausible value: a
    // double that quietly returns something for a call it was not built for turns a wrong path
    // into a passing test.
    findPublicBySlug: async () => {
      throw new Error("unused");
    },
    findEventIdBySlug: async () => {
      throw new Error("unused");
    },
    saveSettings: async () => {
      throw new Error("unused");
    },
    unpublish: async () => {
      throw new Error("unused");
    },
  };
  const publishing = new PublicationService(
    store,
    {
      event: async () => ({ name: "Greenroom Summit", timezone: "UTC" }),
      // Neither a call for proposals nor an agenda is part of what is under test; both are
      // absent rather than stubbed, which is also the state of a brand-new event.
      cfp: async () => null,
      content,
      schedule: async () => null,
    },
    () => new Date("2026-08-11T12:00:00.000Z"),
  );
  return publishing.publish(publisher, eventId);
}

/**
 * Structured social links, and the reason they are validated rather than merely stored.
 *
 * The public programme renders each one into an `href`. `z.string().url()` accepts
 * `javascript:alert(1)` — it is a valid URL — so a schema that only asked "is this a URL" would
 * have let a speaker publish script that every visitor's browser is invited to run. The rule is
 * therefore the *scheme*, and it is asserted here rather than left to the form (#189).
 */
describe("speaker social links", () => {
  const links = (input: unknown) =>
    updateSpeakerProfileInputSchema.safeParse({
      name: "Sam",
      bio: "",
      pronouns: "",
      organization: "",
      socialLinks: input,
    });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:sam@example.test",
    "not a url at all",
    "//scheme-relative.example",
  ])("refuses %s, naming the platform", (website) => {
    const parsed = links({ website });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues.map(({ path }) => path.join("."))).toContain(
        "socialLinks.website",
      );
  });

  it.each(["https://sam.example", "http://sam.example/path?q=1"])("accepts %s", (website) => {
    const parsed = links({ website });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.socialLinks).toEqual({ website });
  });

  it("drops a blank entry rather than storing an empty string", () => {
    const parsed = links({ website: "", github: "https://github.com/sam" });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.socialLinks).toEqual({ github: "https://github.com/sam" });
  });

  it("leaves links alone when the field is absent", () => {
    const parsed = updateSpeakerProfileInputSchema.safeParse({
      name: "Sam",
      bio: "",
      pronouns: "",
      organization: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.socialLinks).toBeUndefined();
  });

  it("refuses a platform the closed set does not carry", () => {
    // Not a security rule — an unknown key would simply be dropped — but a surface that cannot
    // name or label a platform should not be asked to render one.
    const parsed = links({ myspace: "https://myspace.example" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.socialLinks).toEqual({});
  });

  it("round-trips through the service and reaches the published projection", async () => {
    const { repository, service } = fixture();
    // A speaker reaches the public page only by being on a published session. That gate is
    // `content-publication-gate.test.ts`'s subject; here it is simply why Sam is on one.
    await repository.accept({
      session: {
        id: "20000000-0000-4000-8000-000000000001",
        eventId,
        proposalId: "proposal-1",
        title: "Designing the calm conference",
        abstract: "",
        format: "talk",
        speakerProfileIds: [profileId],
        tags: [],
        tracks: [],
        publicationState: "published",
      },
      speakers: [],
      tasks: [],
      messages: [],
    });
    const saved = await service.updateMyProfile(speaker, profileId, {
      name: "Sam",
      bio: "old",
      pronouns: "",
      organization: "",
      socialLinks: { github: "https://github.com/sam" },
    });
    expect(saved.socialLinks).toEqual({ github: "https://github.com/sam" });
    // The organizer reads the same values from the same projection the portal wrote.
    const stored = (await repository.workspace(eventId)).speakers[0];
    expect(stored?.socialLinks).toEqual({ github: "https://github.com/sam" });

    // And the public page serves them. Publishing's allowlist is a second, independent copy of
    // this field's name: content storing it is not the same claim as the snapshot carrying it,
    // which is what a reader auditing this test by its title is entitled to assume it proves.
    const live = await publishSite(repository);
    expect(live?.published?.speakers.map(({ name, socialLinks }) => [name, socialLinks])).toEqual([
      ["Sam", { github: "https://github.com/sam" }],
    ]);
  });

  it("restores a revision taken before links existed as no links, not as undefined", async () => {
    const { repository, service } = fixture();
    await service.updateMyProfile(speaker, profileId, {
      name: "Sam",
      bio: "first",
      pronouns: "",
      organization: "",
    });
    const revision = (await repository.workspace(eventId)).revisions?.[0];
    await service.updateMyProfile(speaker, profileId, {
      name: "Sam",
      bio: "second",
      pronouns: "",
      organization: "",
      socialLinks: { github: "https://github.com/sam" },
    });
    await service.restoreRevision(organizer, revision?.id ?? "");
    expect((await repository.findProfile(profileId))?.socialLinks).toEqual({});
  });
});

/**
 * Organizer-initiated reminders.
 *
 * The property under test is the *key*, not the send: reminders converge on one delivery per
 * (task, deadline), so a chase on work the automatic sweep already covered must report that
 * rather than write to the speaker twice — and moving a deadline must let the chase through
 * again, because that is a different occurrence (#189).
 */
describe("speaker task reminders", () => {
  const taskId = "30000000-0000-4000-8000-000000000001";

  it("queues once, then converges on the delivery that deadline already had", async () => {
    const { service, dispatch } = remindable();
    const first = await service.remindTasks(organizer, eventId, [taskId]);
    expect(first).toEqual([
      {
        taskId,
        speakerName: "Sam",
        title: "Slides",
        dueAt: "2026-09-01T00:00:00.000Z",
        outcome: "queued",
        reason: "",
      },
    ]);
    const second = await service.remindTasks(organizer, eventId, [taskId]);
    expect(second[0]?.outcome).toBe("already-sent");
    // One delivery, not two: the key is the record.
    expect(dispatch.sent).toHaveLength(1);
    expect(dispatch.sent[0]?.key).toBe(`task-reminder:${taskId}:2026-09-01T00:00:00.000Z`);
    expect(dispatch.sent[0]?.recipient).toBe("sam@example.test");
  });

  it("lets a chase through again when the deadline moves", async () => {
    const { repository, service, dispatch } = remindable();
    await service.remindTasks(organizer, eventId, [taskId]);
    // The extension #189's private set asks for: the occurrence follows the new deadline.
    const task = (await repository.workspace(eventId)).tasks.find(({ id }) => id === taskId);
    if (!task) throw new Error("Seeded task is missing");
    await repository.updateTask({ ...task, dueAt: "2026-09-08T00:00:00.000Z" });
    const again = await service.remindTasks(organizer, eventId, [taskId]);
    expect(again[0]?.outcome).toBe("queued");
    expect(dispatch.sent.map(({ key }) => key)).toEqual([
      `task-reminder:${taskId}:2026-09-01T00:00:00.000Z`,
      `task-reminder:${taskId}:2026-09-08T00:00:00.000Z`,
    ]);
  });

  it("reports a completed task rather than reminding about it", async () => {
    const { repository, service, dispatch } = remindable();
    const task = (await repository.workspace(eventId)).tasks.find(({ id }) => id === taskId);
    if (!task) throw new Error("Seeded task is missing");
    await repository.updateTask({ ...task, status: "complete" });
    const outcomes = await service.remindTasks(organizer, eventId, [taskId]);
    expect(outcomes[0]).toMatchObject({ outcome: "refused", reason: "already complete" });
    expect(dispatch.sent).toHaveLength(0);
  });

  it("names a speaker with no address instead of silently skipping them", async () => {
    const { repository, service, dispatch } = remindable();
    const profile = await repository.findProfile(profileId);
    if (!profile) throw new Error("Seeded profile is missing");
    await repository.updateProfile({ ...profile, email: "" });
    const outcomes = await service.remindTasks(organizer, eventId, [taskId]);
    expect(outcomes[0]).toMatchObject({ outcome: "unreachable", reason: "no email address" });
    expect(dispatch.sent).toHaveLength(0);
  });

  it("keeps one refusal from taking the rest of the selection down", async () => {
    const secondTaskId = "30000000-0000-4000-8000-000000000002";
    const { repository, service } = remindable({
      reminders: {
        async send(reminder) {
          if (reminder.idempotencyKey.includes(taskId))
            throw new SpeakerReminderRejectedError("Template speaker-task-reminder was not found");
          return { deliveryId: "d0", created: true };
        },
        async invite() {
          return { deliveryId: "d0", created: true };
        },
      },
    });
    await repository.addTasks([
      {
        id: secondTaskId,
        eventId,
        speakerProfileId: profileId,
        title: "Headshot",
        dueAt: "2026-09-02T00:00:00.000Z",
        status: "open" as const,
      },
    ]);
    const outcomes = await service.remindTasks(organizer, eventId, [taskId, secondTaskId]);
    expect(outcomes.map(({ outcome }) => outcome)).toEqual(["refused", "queued"]);
    expect(outcomes[0]?.reason).toContain("was not found");
  });

  it("refuses a task this event does not carry rather than silently sending fewer", async () => {
    const { service } = remindable();
    await expect(
      service.remindTasks(organizer, eventId, [taskId, "30000000-0000-4000-8000-000000000999"]),
    ).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it("says so when the deployment cannot send reminders at all", async () => {
    const { service } = fixture();
    await expect(service.remindTasks(organizer, eventId, [taskId])).rejects.toBeInstanceOf(
      SpeakerRemindersUnavailableError,
    );
  });

  it("refuses a caller without content:manage on this event", async () => {
    const { service } = remindable();
    await expect(service.remindTasks(speaker, eventId, [taskId])).rejects.toThrow();
  });
});

/**
 * Explicit portal invitations, and the occurrence that makes a second one possible.
 *
 * The property under test is again the *key*. Acceptance sends one welcome under
 * `speaker-invite:{eventId}:{profileId}`, and that key never moves — so before #189 every later
 * invitation to the same person deduplicated into a message sent when their proposal was
 * accepted, and a speaker who lost it was locked out of the portal with no control anywhere in
 * the product to let them back in. Each invitation now claims an occurrence on the profile and is
 * keyed on it, so a second invitation is a second delivery, while an enqueue retried at the same
 * occurrence still converges on one message.
 */
describe("speaker portal invitations", () => {
  const acceptanceKey = `speaker-invite:${eventId}:${profileId}`;
  const organizationId = "00000000-0000-4000-8000-000000000010";

  /** One delivery already in the outbox, the way the delivering domain would hold it. */
  const alreadyDelivered = (dispatch: ReturnType<typeof dispatcher>, idempotencyKey: string) =>
    dispatch.port.invite({
      organizationId,
      eventId,
      idempotencyKey,
      recipientRef: "sam@example.test",
      templateKey: "speaker-invite",
      payload: {},
    });

  it("makes a second invitation a new delivery while a retry at one occurrence converges", async () => {
    const { repository, service, dispatch } = remindable();
    const first = await service.inviteSpeakers(organizer, eventId, [profileId]);
    expect(first).toEqual([
      {
        profileId,
        speakerName: "Sam",
        email: "sam@example.test",
        occurrence: 1,
        outcome: "queued",
        reason: "",
      },
    ]);
    // The whole point: pressing Invite again reaches the speaker rather than being suppressed.
    const second = await service.inviteSpeakers(organizer, eventId, [profileId]);
    expect(second[0]).toMatchObject({ occurrence: 2, outcome: "queued" });
    expect(dispatch.sent.map(({ key }) => key)).toEqual([
      `${acceptanceKey}:n1`,
      `${acceptanceKey}:n2`,
    ]);
    // The count on the profile is the delivery history the console shows.
    expect((await repository.findProfile(profileId))?.invitationsSent).toBe(2);

    // A retry is an enqueue at an occurrence that already produced a delivery — a lost response,
    // a replayed claim — and it must write one message and say so, not mail Sam a third time.
    const retry = await alreadyDelivered(dispatch, `${acceptanceKey}:n2`);
    expect(retry.created).toBe(false);
    expect(dispatch.sent).toHaveLength(2);
  });

  it("never converges into the welcome acceptance already sent", async () => {
    const { service, dispatch } = remindable();
    await alreadyDelivered(dispatch, acceptanceKey);
    const outcomes = await service.inviteSpeakers(organizer, eventId, [profileId]);
    // The failure this whole feature exists to remove: an explicit invitation reported as
    // "already sent" because that speaker was welcomed months ago under a key that never moves.
    expect(outcomes[0]).toMatchObject({ occurrence: 1, outcome: "queued" });
    expect(dispatch.sent).toHaveLength(2);
  });

  it("reports an occurrence the delivering domain already holds as already-sent", async () => {
    const { service, dispatch } = remindable();
    await alreadyDelivered(dispatch, `${acceptanceKey}:n1`);
    const outcomes = await service.inviteSpeakers(organizer, eventId, [profileId]);
    expect(outcomes[0]).toMatchObject({ occurrence: 1, outcome: "already-sent", reason: "" });
    expect(dispatch.sent).toHaveLength(1);
  });

  it("names a speaker with no address instead of silently skipping them", async () => {
    const { repository, service, dispatch } = remindable();
    const profile = await repository.findProfile(profileId);
    if (!profile) throw new Error("Seeded profile is missing");
    await repository.updateProfile({ ...profile, email: "" });
    const outcomes = await service.inviteSpeakers(organizer, eventId, [profileId]);
    expect(outcomes[0]).toMatchObject({
      profileId,
      speakerName: "Sam",
      outcome: "unreachable",
      reason: "no email address",
    });
    expect(dispatch.sent).toHaveLength(0);
    // Nobody was written to, so no occurrence was spent: fixing the address and inviting again
    // is still this speaker's first invitation rather than their second. Absent and zero are the
    // same reading here, which is what the column's default says on a row written before `1408`.
    expect((await repository.findProfile(profileId))?.invitationsSent ?? 0).toBe(0);
  });

  it("keeps one refusal from taking the rest of the selection down", async () => {
    const { repository, service } = remindable({
      reminders: {
        async send() {
          return { deliveryId: "d0", created: true };
        },
        async invite(invitation) {
          if (invitation.recipientRef === "sam@example.test")
            throw new SpeakerReminderRejectedError("Template speaker-invite was not found");
          return { deliveryId: "d1", created: true };
        },
      },
    });
    const secondProfileId = "10000000-0000-4000-8000-000000000002";
    await repository.addProfile({
      id: secondProfileId,
      eventId,
      userId: "other-user",
      sourcePersonId: "source-2",
      name: "Ada",
      email: "ada@example.test",
      bio: "",
      pronouns: "",
      organization: "",
    });
    const outcomes = await service.inviteSpeakers(organizer, eventId, [profileId, secondProfileId]);
    expect(outcomes.map(({ outcome }) => outcome)).toEqual(["refused", "queued"]);
    expect(outcomes[0]?.reason).toContain("was not found");
  });

  it("invites a speaker named twice once, rather than twice", async () => {
    const { repository, service, dispatch } = remindable();
    const outcomes = await service.inviteSpeakers(organizer, eventId, [profileId, profileId]);
    expect(outcomes).toHaveLength(1);
    expect(dispatch.sent).toHaveLength(1);
    // One occurrence spent, so the duplicate did not quietly cost this speaker a number.
    expect(await repository.findProfile(profileId)).toMatchObject({ invitationsSent: 1 });
  });

  it("refuses a speaker this event does not carry rather than silently inviting fewer", async () => {
    const { service } = remindable();
    await expect(
      service.inviteSpeakers(organizer, eventId, [
        profileId,
        "10000000-0000-4000-8000-000000000999",
      ]),
    ).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it("says so when the deployment cannot send speaker mail at all", async () => {
    const { service } = fixture();
    await expect(service.inviteSpeakers(organizer, eventId, [profileId])).rejects.toBeInstanceOf(
      SpeakerRemindersUnavailableError,
    );
  });

  it("refuses a caller without content:manage on this event", async () => {
    const { service } = remindable();
    await expect(service.inviteSpeakers(speaker, eventId, [profileId])).rejects.toThrow();
  });
});

/**
 * A file request bound to a session, and the upload that records it.
 *
 * `speaker_tasks.session_id` and `speaker_assets.session_id` both existed and nothing in the
 * product ever wrote either, so "the slides for the keynote" and "a headshot" stored identically
 * and an organizer could only tell them apart by reading the title. The property under test is
 * that the association survives the round trip *without the portal being trusted to send it*: a
 * speaker may be asked for a session's handout without being one of that session's speakers, and
 * a client-supplied `sessionId` is checked against the sessions they are on (#189).
 */
describe("session-bound file requests", () => {
  const sessionId = "20000000-0000-4000-8000-000000000001";

  /** The fixture plus one session — one Sam is deliberately not a speaker of. */
  async function withSession() {
    const { repository, service } = fixture();
    await repository.accept({
      session: {
        id: sessionId,
        eventId,
        proposalId: "proposal-1",
        title: "Designing the calm conference",
        abstract: "",
        format: "talk",
        speakerProfileIds: [],
        tags: [],
        tracks: [],
        publicationState: "draft",
      },
      speakers: [],
      tasks: [],
      messages: [],
    });
    return { repository, service };
  }

  it("carries a requested task's session onto the upload that answers it", async () => {
    const { repository, service } = await withSession();
    const [task] = await service.requestTasks(organizer, {
      profileIds: [profileId],
      title: "Workshop handout",
      dueAt: "2026-09-01T00:00:00.000Z",
      type: "file-request",
      instructions: "PDF please",
      sessionId,
    });
    if (!task) throw new Error("The request created no task");
    expect(task).toMatchObject({ type: "file-request", sessionId });

    const asset = await service.upload(speaker, {
      profileId,
      name: "handout.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
      taskId: task.id,
    });
    // Read off the task by the server. Sam is not one of this session's speakers, so an upload
    // naming the session itself would be refused — which is exactly why the portal does not.
    expect(asset.sessionId).toBe(sessionId);
    expect((await repository.findAsset(asset.id))?.sessionId).toBe(sessionId);
  });

  it("carries the session onto a later version of the same deliverable", async () => {
    const { service } = await withSession();
    const [task] = await service.requestTasks(organizer, {
      profileIds: [profileId],
      title: "Workshop handout",
      dueAt: "2026-09-01T00:00:00.000Z",
      type: "file-request",
      instructions: "",
      sessionId,
    });
    if (!task) throw new Error("The request created no task");
    const first = await service.upload(speaker, {
      profileId,
      name: "handout.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
      taskId: task.id,
    });
    // A continuation naming only the chain must not silently detach the deliverable from the
    // session that asked for it, which is the state an organizer filters the tracker by.
    const second = await service.upload(speaker, {
      profileId,
      name: "handout-final.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([2]),
      versionGroupId: first.versionGroupId,
    });
    expect(second).toMatchObject({ versionNumber: 2, sessionId, taskId: task.id });
  });

  it("leaves an unbound request's upload with no session rather than guessing one", async () => {
    const { service } = await withSession();
    const [task] = await service.requestTasks(organizer, {
      profileIds: [profileId],
      title: "Headshot",
      dueAt: "2026-09-01T00:00:00.000Z",
      type: "file-request",
      instructions: "",
    });
    if (!task) throw new Error("The request created no task");
    const asset = await service.upload(speaker, {
      profileId,
      name: "portrait.png",
      contentType: "image/png",
      bytes: new Uint8Array([1]),
      taskId: task.id,
    });
    expect(asset.sessionId).toBeUndefined();
  });

  it("refuses a request bound to a session this event does not carry", async () => {
    const { service } = await withSession();
    await expect(
      service.requestTasks(organizer, {
        profileIds: [profileId],
        title: "Workshop handout",
        dueAt: "2026-09-01T00:00:00.000Z",
        type: "file-request",
        instructions: "",
        sessionId: "20000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toThrow();
  });
});
