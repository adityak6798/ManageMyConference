// @acceptance ACC-SPEAKER
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import {
  type ContentDatabasePort,
  D1ContentRepository,
} from "../src/adapters/persistence/d1-content-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import {
  type D1ReviewDatabasePort,
  D1ReviewRepository,
} from "../src/adapters/persistence/d1-review-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { ContentConflictError } from "../src/application/content/content-repository";
import type { SpeakerProfile } from "../src/domain/content/content";
import {
  ContentService,
  SpeakerPhotoInvalidError,
} from "../src/application/content/content-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import { ProposalNotFoundError } from "../src/application/review/public";
import { ReviewService } from "../src/application/review/review-service";
import { createMigratedDatabase } from "./support/seeded-d1";

const _statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
describe("D1ContentRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("projects schedulable and speaker-owned content directly from real D1", async () => {
    const migrated = await createMigratedDatabase({ label: "content-projections", seed: true });
    runtime = migrated.runtime;
    const repository = new D1ContentRepository(migrated.database as ContentDatabasePort);
    const eventId = "00000000-0000-4000-8000-000000000001";

    const schedulable = await repository.listSchedulableSessions(eventId);
    expect(schedulable.length).toBeGreaterThan(1);
    expect(schedulable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "20000000-0000-4000-8000-000000000001",
          speakerProfileIds: ["10000000-0000-4000-8000-000000000001"],
        }),
      ]),
    );

    const speaker = await repository.workspace(eventId, "seed-speaker");
    expect(speaker.speakers).toHaveLength(1);
    expect(speaker.sessions.length).toBeGreaterThan(0);
    expect(
      speaker.sessions.every(({ speakerProfileIds }) =>
        speakerProfileIds.includes("10000000-0000-4000-8000-000000000001"),
      ),
    ).toBe(true);
    expect(
      [...speaker.tasks, ...speaker.assets, ...speaker.messages].every(
        ({ speakerProfileId }) => speakerProfileId === "10000000-0000-4000-8000-000000000001",
      ),
    ).toBe(true);
  });
  it("rolls back a failed acceptance and permits a clean retry", async () => {
    const migrated = await createMigratedDatabase({ label: "content", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1ContentRepository(database as ContentDatabasePort);
    const session = {
      id: "50000000-0000-4000-8000-000000000001",
      eventId: "00000000-0000-4000-8000-000000000001",
      proposalId: "atomic-proposal",
      title: "Atomic acceptance",
      abstract: "Must roll back",
      format: "Talk",
      speakerProfileIds: ["50000000-0000-4000-8000-000000000002"],
      tags: [],
      tracks: [],
      publicationState: "draft" as const,
    };
    const invalidProfile = {
      id: "50000000-0000-4000-8000-000000000002",
      eventId: session.eventId,
      userId: "missing-user",
      sourcePersonId: "atomic-person",
      name: "Atomic Speaker",
      email: "atomic@example.test",
      bio: "",
      pronouns: "",
      organization: "",
    };
    await expect(
      repository.accept({ session, speakers: [invalidProfile], tasks: [], messages: [] }),
    ).rejects.toThrow();
    await expect(
      repository.findSessionByProposal(session.eventId, session.proposalId),
    ).resolves.toBeNull();
    const validProfile = { ...invalidProfile, userId: "seed-speaker" };
    await expect(
      repository.accept({ session, speakers: [validProfile], tasks: [], messages: [] }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findSessionByProposal(session.eventId, session.proposalId),
    ).resolves.toEqual(session);
    // The rest of this case drives acceptance through the real chain: the CFP submission the
    // seed carries, the review decision recorded on it, and the speaker conversion port that
    // provisions the user and profile together.
    const identities = new D1IdentityDirectory(database);
    const reviewService = new ReviewService({
      repository: new D1ReviewRepository(database as D1ReviewDatabasePort),
      proposals: new D1SubmittedProposalAdapter(database as D1ProposalDatabasePort),
      identities,
      events: {
        get: async () => ({
          id: session.eventId,
          organizationId: "00000000-0000-4000-8000-000000000010",
          name: "Greenroom Demo Summit",
          timezone: "America/Los_Angeles",
          createdAt: "2026-08-09T12:00:00.000Z",
        }),
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const organizer = await resolveSeededDemoActor("organizer");
    const decidedProposalId = "10000000-0000-4000-8000-000000000002";
    await reviewService.decide(organizer, session.eventId, [decidedProposalId], "accepted", "Yes");
    const command = { eventId: session.eventId, proposalId: decidedProposalId };
    const makeService = (prefix: string) => {
      let id = 0;
      const newId = () => `${prefix}0000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
      return new ContentService({
        repository,
        assetStorage: new DeterministicAssetStorage(),
        proposals: reviewService,
        agenda: new AgendaService(
          new D1AgendaRepository(database, () => new Date("2026-08-10T12:00:00.000Z")),
          () => new Date("2026-08-10T12:00:00.000Z"),
          repository,
        ),
        speakerConversion: new D1SpeakerConversion(database, () => crypto.randomUUID(), identities),
        newId,
        now: () => new Date("2026-08-10T12:00:00.000Z"),
      });
    };
    // A proposal nobody submitted cannot become content, whatever the caller sends.
    await expect(
      makeService("5").accept(organizer, { ...command, proposalId: "invented" }, "correlation-0"),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    const results = await Promise.all([
      makeService("6").accept(organizer, command, "correlation-1"),
      makeService("7").accept(organizer, command, "correlation-2"),
    ]);
    expect(
      results[0].sessions.filter(({ proposalId }) => proposalId === command.proposalId),
    ).toHaveLength(1);
    expect(
      results[1].sessions.filter(({ proposalId }) => proposalId === command.proposalId),
    ).toHaveLength(1);
    const canonical = await repository.workspace(command.eventId);
    expect(
      canonical.sessions.filter(({ proposalId }) => proposalId === command.proposalId),
    ).toHaveLength(1);
    // One speaker for the submitter's address, provisioned by the conversion port. The
    // profile's `user_id` is a real `users` row, which is what used to 500 when a caller was
    // allowed to name it.
    const converted = canonical.speakers.filter(({ email }) => email === "jordan.lee@example.test");
    expect(converted).toHaveLength(1);
    expect(converted[0]?.name).toBe("Jordan Lee");
    await expect(
      identities.isSpeakerForEvent(converted[0]?.userId ?? "", command.eventId),
    ).resolves.toBe(true);
    // The session took its title and abstract from the submission, not from the caller.
    expect(
      canonical.sessions.find(({ proposalId }) => proposalId === command.proposalId),
    ).toMatchObject({
      title: "Typed boundaries at scale",
      abstract: "How small explicit contracts keep large TypeScript systems understandable.",
    });
    // Exactly one onboarding checklist survived the race.
    expect(
      canonical.tasks.filter(({ speakerProfileId }) => speakerProfileId === converted[0]?.id),
    ).toHaveLength(2);
    const managedSessionSource = canonical.sessions.find(
      ({ proposalId }) => proposalId === command.proposalId,
    );
    if (!managedSessionSource) throw new Error("Concurrent session was not persisted");
    const managedSession = {
      ...managedSessionSource,
      title: "Managed in D1",
      publicationState: "ready" as const,
    };
    await repository.updateSession(managedSession);
    await expect(repository.findSession(managedSession.id)).resolves.toEqual(managedSession);
    const managedProfile = converted[0];
    if (!managedProfile) throw new Error("Concurrent speaker was not persisted");
    const privateAsset = {
      id: "80000000-0000-4000-8000-000000000001",
      eventId: command.eventId,
      speakerProfileId: managedProfile.id,
      name: "headshot.png",
      contentType: "image/png",
      storageKey: "event/profile/asset",
      visibility: "private" as const,
      uploadedAt: "2026-08-10T12:00:00.000Z",
      versionGroupId: "80000000-0000-4000-8000-000000000001",
      versionNumber: 1,
      isLatest: true,
    };
    await repository.addAsset(privateAsset);
    await expect(repository.findAsset(privateAsset.id)).resolves.toEqual(privateAsset);
    await repository.updateAsset({ ...privateAsset, visibility: "publishable" });
    await expect(repository.findAsset(privateAsset.id)).resolves.toMatchObject({
      visibility: "publishable",
    });

    // The headshot link, against real D1: `photo_asset_id` round-trips through the same
    // `UPDATE speaker_profiles` the profile edit uses, only an image is accepted, and the
    // asset visibility is left exactly where the organizer put it.
    const photoService = makeService("8");
    await expect(
      photoService.setProfilePhoto(organizer, managedProfile.id, privateAsset.id),
    ).resolves.toMatchObject({ photoAssetId: privateAsset.id });
    await expect(repository.findProfile(managedProfile.id)).resolves.toMatchObject({
      photoAssetId: privateAsset.id,
    });
    await expect(repository.findAsset(privateAsset.id)).resolves.toMatchObject({
      visibility: "publishable",
    });
    const slides = {
      ...privateAsset,
      id: "80000000-0000-4000-8000-000000000002",
      name: "slides.pdf",
      contentType: "application/pdf",
      storageKey: "event/profile/slides",
      versionGroupId: "80000000-0000-4000-8000-000000000002",
    };
    await repository.addAsset(slides);
    const slidesV2 = {
      ...slides,
      id: "80000000-0000-4000-8000-000000000003",
      storageKey: "event/profile/slides-v2",
      versionNumber: 2,
    };
    await repository.replaceLatestAsset(slidesV2, slides);
    await repository.deleteAsset(slidesV2.id);
    await expect(repository.findAsset(slides.id)).resolves.toMatchObject({ isLatest: true });
    await expect(
      photoService.setProfilePhoto(organizer, managedProfile.id, slides.id),
    ).rejects.toBeInstanceOf(SpeakerPhotoInvalidError);
    await photoService.clearProfilePhoto(organizer, managedProfile.id);
    expect(await repository.findProfile(managedProfile.id)).not.toHaveProperty("photoAssetId");
  });
});

/**
 * Attributed history against real D1, where the guarantees actually live.
 *
 * A revision and the edit it describes used to be two calls, and a database is the only place
 * that can prove they are now one: a memory repository has no constraint to violate halfway
 * through, and no second writer to lose a race to. Both cases below are the ones issue #116
 * names — a canonical write that fails after the revision is written, and two editors reaching
 * for the same revision number — and both assert an outcome rather than the absence of a crash.
 */
describe("D1ContentRepository revisions", () => {
  const eventId = "00000000-0000-4000-8000-000000000001";
  const profileId = "10000000-0000-4000-8000-000000000001";
  const sessionId = "20000000-0000-4000-8000-000000000001";
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  /**
   * The database, with one writer let in between a revised edit's read and its batch.
   *
   * The window this closes is invisible to two callers racing through the public API, because
   * nothing there lets a test say "now, while that edit is deciding what to write". Wrapping
   * the port does: `interleave` runs once, immediately before the first batch, which is exactly
   * the instant the guard exists to survive. It is a test seam, not a production hook — the
   * repository under test is the real one and sees the real database.
   */
  function withWriterBetweenReadAndWrite(
    database: ContentDatabasePort,
    interleave: () => Promise<unknown>,
  ): ContentDatabasePort {
    let pending: (() => Promise<unknown>) | null = interleave;
    return {
      prepare: (query) => database.prepare(query),
      batch: async (statements) => {
        const run = pending;
        pending = null;
        if (run) await run();
        return database.batch(statements);
      },
    };
  }

  /** A migrated, seeded database with a repository and a `ContentService` factory over it. */
  async function fixture(label: string) {
    const migrated = await createMigratedDatabase({ label, seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1ContentRepository(database as ContentDatabasePort);
    const now = () => new Date("2026-08-10T12:00:00.000Z");
    // Each service gets its own id sequence, so a revision is traceable to the caller that
    // wrote it even when two of them are in flight at once.
    const service = (prefix: string) => {
      let id = 0;
      return new ContentService({
        repository,
        assetStorage: new DeterministicAssetStorage(),
        proposals: {
          acceptedProposal: async () => {
            throw new ProposalNotFoundError();
          },
        },
        agenda: new AgendaService(new D1AgendaRepository(database, now), now, repository),
        speakerConversion: new D1SpeakerConversion(
          database,
          () => crypto.randomUUID(),
          new D1IdentityDirectory(database),
        ),
        newId: () => `${prefix}0000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
        now,
      });
    };
    const revisions = async () =>
      ((await repository.workspace(eventId)).revisions ?? []).toSorted(
        (left, right) => left.revisionNumber - right.revisionNumber,
      );
    return { database: database as ContentDatabasePort, repository, service, revisions };
  }

  const draft = (id: string) => ({
    id,
    eventId,
    actorId: "seed-organizer",
    createdAt: "2026-08-10T12:00:00.000Z",
  });

  it("writes no revision when the canonical update is refused", async () => {
    const { repository, revisions } = await fixture("content-revision-atomicity");
    const before = await repository.findProfile(profileId);

    // Driven at the repository because the HTTP contract makes this state unreachable through
    // the service — which is the point: the constraint is the last line, and this proves the
    // revision does not survive the write it describes being rolled back.
    await expect(
      repository.reviseProfile(
        profileId,
        draft("a0000000-0000-4000-8000-000000000001"),
        (current) => ({
          ...current,
          workflowStatus: "not-a-status" as SpeakerProfile["workflowStatus"],
        }),
      ),
    ).rejects.toThrow(/CHECK constraint failed|D1 content revision failed/);

    expect(await revisions()).toEqual([]);
    expect(await repository.findProfile(profileId)).toEqual(before);
  });

  it("gives two concurrent profile edits a number each, and loses neither", async () => {
    const { repository, service, revisions } = await fixture("content-revision-race");
    const organizer = await resolveSeededDemoActor("organizer");

    const outcomes = await Promise.all([
      service("b").updateSpeakerWorkflow(organizer, profileId, {
        workflowStatus: "ready",
        logistics: { hotel: "confirmed" },
        customFields: {},
      }),
      service("c").updateSpeakerWorkflow(organizer, profileId, {
        workflowStatus: "blocked",
        logistics: {},
        customFields: { shirt: "M" },
      }),
    ]);

    // Neither edit was refused, and neither took the other's number.
    const history = await revisions();
    expect(history.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2]);
    expect(new Set(history.map(({ id }) => id)).size).toBe(2);
    expect(history.every(({ actorId }) => actorId === organizer.id)).toBe(true);
    expect(history.every(({ entityId }) => entityId === profileId)).toBe(true);

    // Whichever edit landed second is the profile; the one it replaced is the second
    // revision's snapshot, so the organizer who lost the race can still see and restore what
    // they wrote. That is the difference between an overwrite and a disappearance.
    const stored = await repository.findProfile(profileId);
    const replaced = JSON.parse(history[1]?.snapshotJson ?? "{}");
    expect(outcomes).toContainEqual(stored);
    expect(outcomes).toContainEqual(replaced);
    expect(replaced).not.toEqual(stored);
    expect(JSON.parse(history[0]?.snapshotJson ?? "{}")).toMatchObject({ name: "Sam Speaker" });
  });

  it("keeps a restore racing an edit in one history, whichever wins", async () => {
    const { repository, service, revisions } = await fixture("content-revision-restore-race");
    const organizer = await resolveSeededDemoActor("organizer");
    const original = await repository.findSession(sessionId);
    if (!original) throw new Error("Seeded session is missing");
    const edit = {
      title: "Designing the calm conference, revised",
      abstract: original.abstract,
      format: original.format,
      speakerProfileIds: [...original.speakerProfileIds],
      tags: [...original.tags],
      tracks: [...original.tracks],
      publicationState: "ready" as const,
    };
    await service("d").updateSession(organizer, sessionId, edit);
    const first = (await revisions())[0];
    if (!first) throw new Error("The first edit recorded no revision");

    await Promise.all([
      service("e").restoreRevision(organizer, first.id),
      service("f").updateSession(organizer, sessionId, { ...edit, publicationState: "draft" }),
    ]);

    const history = await revisions();
    expect(history.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2, 3]);
    expect(history.filter(({ restoredFromRevisionId }) => restoredFromRevisionId)).toHaveLength(1);
    expect(history.every(({ actorId }) => actorId === organizer.id)).toBe(true);

    // The last writer owns the session, and the history says which one that was: a restore
    // last leaves the snapshot it named, an edit last leaves the edit applied on top of it.
    const stored = await repository.findSession(sessionId);
    expect(stored).toEqual(
      history[2]?.restoredFromRevisionId
        ? original
        : { ...original, ...edit, publicationState: "draft" },
    );
  });

  it("writes nothing and answers null when the row is deleted mid-edit", async () => {
    const { database, repository, revisions } = await fixture("content-revision-deleted");
    const withdrawn = new D1ContentRepository(
      withWriterBetweenReadAndWrite(database, () => repository.deleteSession(sessionId)),
    );

    // The organizer's edit read a session another organizer withdrew a moment later. A
    // zero-row `UPDATE` is a *success* in D1, so without the guard this would answer the
    // caller with an edited session and leave a revision describing an edit to a session that
    // no longer exists.
    await expect(
      withdrawn.reviseSession(
        sessionId,
        draft("a0000000-0000-4000-8000-000000000002"),
        (current) => ({
          ...current,
          title: "Edited after withdrawal",
        }),
      ),
    ).resolves.toBeNull();
    expect(await revisions()).toEqual([]);
    expect(await repository.findSession(sessionId)).toBeNull();
  });

  it("neither reverts a concurrent headshot nor claims a state the row had already left", async () => {
    const { database, repository, revisions } = await fixture("content-revision-interleaved");
    const headshot = {
      id: "80000000-0000-4000-8000-000000000009",
      eventId,
      speakerProfileId: profileId,
      name: "sam-portrait.png",
      contentType: "image/png",
      storageKey: `${eventId}/${profileId}/80000000-0000-4000-8000-000000000009`,
      visibility: "private" as const,
      uploadedAt: "2026-08-10T11:00:00.000Z",
      versionGroupId: "80000000-0000-4000-8000-000000000009",
      versionNumber: 1,
      isLatest: true,
    };
    await repository.addAsset(headshot);
    // `setProfilePhoto` records no revision, so the uniqueness guard on revision numbers cannot
    // see it coming. It is the writer most likely to be in flight during an organizer's edit,
    // because it is the speaker working on their own profile at the same time.
    const chooseHeadshot = () =>
      database
        .prepare("UPDATE speaker_profiles SET photo_asset_id=? WHERE id=?")
        .bind(headshot.id, profileId)
        .run();
    const organizerEdit = new D1ContentRepository(
      withWriterBetweenReadAndWrite(database, chooseHeadshot),
    );

    const updated = await organizerEdit.reviseProfile(
      profileId,
      draft("a0000000-0000-4000-8000-000000000003"),
      (current) => ({ ...current, workflowStatus: "ready" as const }),
    );

    // The organizer's edit read a profile with no headshot. Writing every column back from that
    // read would have erased the speaker's choice while they were making it.
    expect(updated).toMatchObject({ workflowStatus: "ready", photoAssetId: headshot.id });
    expect(await repository.findProfile(profileId)).toMatchObject({
      workflowStatus: "ready",
      photoAssetId: headshot.id,
    });
    // And the revision says what was actually there when it was written, not what the edit had
    // read a moment earlier — the whole point of recording it.
    const history = await revisions();
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]?.snapshotJson ?? "{}")).toMatchObject({
      photoAssetId: headshot.id,
      workflowStatus: "onboarding",
    });
  });

  it("writes only the columns a narrow writer owns, against the real schema", async () => {
    const { repository } = await fixture("content-narrow-writes");
    const before = await repository.findProfile(profileId);
    if (!before) throw new Error("Seeded profile is missing");

    // Every column these two statements name is checked against the migrated schema here and
    // nowhere else. A typo — `logistics_jsn`, or a transposed bind — is invisible to a memory
    // repository, passes every unit test, and only fails once it reaches a real database.
    await repository.updateProfileWorkflow(profileId, {
      workflowStatus: "ready",
      logistics: { hotel: "confirmed" },
      customFields: { shirt: "M" },
    });
    const enriched = await repository.findProfile(profileId);
    expect(enriched).toEqual({
      ...before,
      workflowStatus: "ready",
      logistics: { hotel: "confirmed" },
      customFields: { shirt: "M" },
    });

    await repository.updateProfilePhoto(profileId, "90000000-0000-4000-8000-000000000001");
    expect(await repository.findProfile(profileId)).toEqual({
      ...enriched,
      photoAssetId: "90000000-0000-4000-8000-000000000001",
    });
    // Clearing the headshot leaves the import's three columns exactly where the import put them.
    await repository.updateProfilePhoto(profileId, null);
    expect(await repository.findProfile(profileId)).toEqual(enriched);
  });

  it("refuses with a conflict rather than a silent no-op when it never wins the row", async () => {
    const { database, repository, revisions } = await fixture("content-revision-conflict");
    const before = await repository.findProfile(profileId);
    const contended = new D1ContentRepository({
      prepare: (query) => database.prepare(query),
      batch: async (statements) =>
        statements.map(() => ({
          success: false,
          meta: { changes: 0 },
          error:
            "UNIQUE constraint failed: content_revisions.entity_type, content_revisions.entity_id, content_revisions.revision_number",
        })),
    });

    await expect(
      contended.reviseProfile(
        profileId,
        draft("a0000000-0000-4000-8000-000000000004"),
        (current) => ({
          ...current,
          organization: "Never lands",
        }),
      ),
    ).rejects.toBeInstanceOf(ContentConflictError);
    // The 409 an organizer sees is contention, and it leaves the record exactly as it found it.
    expect(await revisions()).toEqual([]);
    expect(await repository.findProfile(profileId)).toEqual(before);
  });
});
