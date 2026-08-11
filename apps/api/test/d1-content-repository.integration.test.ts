// @acceptance ACC-SPEAKER
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
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
import {
  ContentService,
  SpeakerPhotoInvalidError,
} from "../src/application/content/content-service";
import { ReviewService } from "../src/application/review/review-service";
import { ProposalNotFoundError } from "../src/application/review/public";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
describe("D1ContentRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());
  it("rolls back a failed acceptance and permits a clean retry", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "content-atomic-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const file of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_cfp.sql",
      "0004_cfp_published_snapshot.sql",
      "0005_cfp_snapshot_status.sql",
      "0006_review_workflow.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    for (const file of [
      "0007_review_completion_conflict_guard.sql",
      "0008_review_conflict_completion_guard.sql",
      "0009_review_assignment_requires_plan.sql",
      "0010_review_plan_lock.sql",
      "0011_cfp_transition_status_guard.sql",
      "0012_cfp_status_in_use_guard.sql",
      "0013_cfp_submission_default_status.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      expect((await database.prepare(sql).run()).success).toBe(true);
    }
    const contentSql = await readFile(
      new URL("../migrations/0014_content_speaker_portal.sql", import.meta.url),
      "utf8",
    );
    for (const statement of statements(contentSql)) await database.prepare(statement).run();
    for (const migration of ["0015_crm_conversion.sql", "0016_crm_speaker_conversion.sql"]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    for (const migration of ["0017_agenda.sql", "0018_agenda_draft_revision.sql"]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    const trailingMigrations = (
      await Promise.all([
        readFile(new URL("../migrations/0019_communications_outbox.sql", import.meta.url), "utf8"),
        readFile(
          new URL("../migrations/0020_public_event_projections.sql", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../migrations/0021_review_decisions.sql", import.meta.url), "utf8"),
      ])
    ).join("\n");
    for (const statement of statements(trailingMigrations)) await database.prepare(statement).run();
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset))
      expect((await database.prepare(statement).run()).success, statement).toBe(true);
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
    };
    await repository.addAsset(slides);
    await expect(
      photoService.setProfilePhoto(organizer, managedProfile.id, slides.id),
    ).rejects.toBeInstanceOf(SpeakerPhotoInvalidError);
    await photoService.clearProfilePhoto(organizer, managedProfile.id);
    expect(await repository.findProfile(managedProfile.id)).not.toHaveProperty("photoAssetId");
  });
});
