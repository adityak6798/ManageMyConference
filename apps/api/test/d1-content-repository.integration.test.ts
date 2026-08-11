// @acceptance ACC-SPEAKER
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContentDatabasePort,
  D1ContentRepository,
} from "../src/adapters/persistence/d1-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
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
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
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
    const command = {
      eventId: session.eventId,
      proposalId: "concurrent-proposal",
      title: "Concurrent acceptance",
      abstract: "Converges",
      format: "Talk",
      tags: [],
      tracks: [],
      speakers: [
        {
          userId: "seed-speaker",
          sourcePersonId: "concurrent-person",
          name: "Sam Speaker",
          email: "sam@example.test",
        },
      ],
    };
    const makeService = (prefix: string) => {
      let id = 0;
      return new ContentService({
        repository,
        assetStorage: new DeterministicAssetStorage(),
        newId: () => `${prefix}0000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
        now: () => new Date("2026-08-10T12:00:00.000Z"),
      });
    };
    const organizer = await resolveSeededDemoActor("organizer");
    const results = await Promise.all([
      makeService("6").accept(organizer, command),
      makeService("7").accept(organizer, command),
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
    expect(
      canonical.speakers.filter(({ sourcePersonId }) => sourcePersonId === "concurrent-person"),
    ).toHaveLength(1);
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
    const managedProfile = canonical.speakers.find(
      ({ sourcePersonId }) => sourcePersonId === "concurrent-person",
    );
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
  });
});
