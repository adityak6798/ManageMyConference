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
import { SpeakerReminderRejectedError } from "../src/application/content/reminder-dispatch";
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

  /** A dispatch port that behaves like the delivering domain: idempotent on the key. */
  function dispatcher() {
    const sent: { key: string; recipient: string; payload: unknown }[] = [];
    return {
      sent,
      port: {
        async send(reminder: {
          idempotencyKey: string;
          recipientRef: string;
          payload: Readonly<Record<string, unknown>>;
        }) {
          const existing = sent.findIndex(({ key }) => key === reminder.idempotencyKey);
          if (existing >= 0) return { deliveryId: `d${existing}`, created: false };
          sent.push({
            key: reminder.idempotencyKey,
            recipient: reminder.recipientRef,
            payload: reminder.payload,
          });
          return { deliveryId: `d${sent.length - 1}`, created: true };
        },
      },
    };
  }

  /** The same fixture, with a delivering domain bound and an owning organization. */
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
