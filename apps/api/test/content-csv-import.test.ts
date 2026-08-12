// @acceptance ACC-SPEAKER
import { describe, expect, it } from "vitest";
import { parseSpeakerCsv } from "../src/adapters/content/parse-speaker-csv";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import type { Actor } from "../src/application/identity/actor";

describe("speaker CSV import parsing", () => {
  it("handles quoted commas and preserves row numbers for malformed input", () => {
    const parsed = parseSpeakerCsv(
      'name,email,workflowStatus\n"Doe, Alex",alex@example.test,ready\nSam,sam@example.test,onboarding',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        name: "Doe, Alex",
        email: "alex@example.test",
        workflowStatus: "ready",
        logistics: undefined,
        customFields: undefined,
      },
      {
        name: "Sam",
        email: "sam@example.test",
        workflowStatus: "onboarding",
        logistics: undefined,
        customFields: undefined,
      },
    ]);
  });
});

it("resumes a claimed row after profile enrichment fails and validates JSON before conversion", async () => {
  const eventId = "00000000-0000-4000-8000-000000000001";
  const profileId = "10000000-0000-4000-8000-000000000001";
  const repository = new MemoryContentRepository({
    sessions: [],
    speakers: [],
    tasks: [],
    assets: [],
    messages: [],
  });
  let failEnrichment = true;
  // The write the import actually makes: the three columns it owns, not the whole profile row.
  const updateProfileWorkflow = repository.updateProfileWorkflow.bind(repository);
  repository.updateProfileWorkflow = async (profileId, fields) => {
    if (failEnrichment) {
      failEnrichment = false;
      throw new Error("transient");
    }
    await updateProfileWorkflow(profileId, fields);
  };
  let conversions = 0;
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
    speakerConversion: {
      createOrLink: async (command) => {
        conversions += 1;
        if (!(await repository.findProfile(profileId)))
          await repository.addProfile({
            id: profileId,
            eventId,
            userId: "speaker",
            sourcePersonId: command.source.id,
            name: command.name,
            email: command.email,
            bio: "",
            pronouns: "",
            organization: "",
          });
        return { speakerId: profileId };
      },
    },
    newId: () => "90000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    parseSpeakerCsv,
  });
  const organizer: Actor = {
    id: "organizer",
    name: "Organizer",
    persona: "organizer",
    organizations: [],
    capabilities: new Set(["content:manage"]),
    eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["content:manage"]) }],
  };
  const csv = `name,email,workflowStatus,logistics
Sam,SAM@example.test,ready,"{""hotel"":""yes""}"`;
  const first = await service.importSpeakers(
    organizer,
    { eventId, csv, commit: true },
    "correlation",
  );
  expect(first.rows[0]?.errors).toContain("Import failed; retry this row safely");
  const retry = await service.importSpeakers(
    organizer,
    { eventId, csv, commit: true },
    "correlation",
  );
  expect(retry.imported).toBe(1);
  expect((await repository.findProfile(profileId))?.workflowStatus).toBe("ready");
  expect(conversions).toBe(2);
  const invalid = await service.importSpeakers(
    organizer,
    { eventId, csv: "name,email,logistics\nAlex,alex@example.test,{broken", commit: false },
    "correlation",
  );
  expect(invalid.rows[0]?.errors).toContain("Logistics must be valid JSON");
  const semanticInvalid = await service.importSpeakers(
    organizer,
    {
      eventId,
      csv: 'name,email,workflowStatus,customFields\nAlex,alex@example.test,unknown,"{""hotel"":true}"',
      commit: false,
    },
    "correlation",
  );
  expect(semanticInvalid.rows[0]?.errors).toEqual([
    "Workflow status is invalid",
    "Custom fields values must be strings",
  ]);
  const structuralInvalid = await service.importSpeakers(
    organizer,
    { eventId, csv: "name,email\nAlex,alex@example.test,extra", commit: true },
    "correlation",
  );
  expect(structuralInvalid.imported).toBe(0);
  expect(structuralInvalid.rows[0]?.errors).toContain(
    "Too many fields: expected 2 fields but parsed 3",
  );
});
