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
  repository.updateProfileWorkflow = async (enriched, fields) => {
    if (failEnrichment) {
      failEnrichment = false;
      throw new Error("transient");
    }
    return updateProfileWorkflow(enriched, fields);
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

/**
 * The decision issue #202 was waiting on, asserted as behaviour.
 *
 * `updateProfileWorkflow` is the CSV import's only production writer, and it went unguarded
 * because "skip the row, refuse it, or fail the batch" is a product question about imports
 * rather than a repair to the write rule. The answer `PRD-SPK-001` now records is **refuse the
 * row**: it is reported to the organizer, it is not counted, the ledger stays `pending`, and
 * every other row in the same file still lands.
 *
 * What this replaces is worth naming, because it is the same defect one level up. The code used
 * to read `if (profile) { …write… }` and then mark the import complete regardless — so a speaker
 * deleted between `createOrLink` and the enrichment was counted as imported and the ledger
 * recorded a run that wrote nothing. Both halves are driven below.
 */
describe("a CSV import whose speaker vanishes mid-run", () => {
  const eventId = "00000000-0000-4000-8000-000000000001";
  const profileId = "10000000-0000-4000-8000-000000000001";
  const organizer: Actor = {
    id: "organizer",
    name: "Organizer",
    persona: "organizer",
    organizations: [],
    capabilities: new Set(["content:manage"]),
    eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["content:manage"]) }],
  };
  const csv = "name,email,workflowStatus\nSam,SAM@example.test,ready\nAlex,alex@example.test,ready";

  function setup(vanish: (repository: MemoryContentRepository) => Promise<void>) {
    const repository = new MemoryContentRepository({
      sessions: [],
      speakers: [],
      tasks: [],
      assets: [],
      messages: [],
    });
    let created = 0;
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
          created += 1;
          const id = created === 1 ? profileId : `${profileId.slice(0, -1)}${created}`;
          if (!(await repository.findProfile(id)))
            await repository.addProfile({
              id,
              eventId,
              userId: `speaker-${created}`,
              sourcePersonId: command.source.id,
              name: command.name,
              email: command.email,
              bio: "",
              pronouns: "",
              organization: "",
            });
          // The first row's speaker goes between the conversion and the enrichment write —
          // exactly the window the affected-row count exists to see.
          if (created === 1) await vanish(repository);
          return { speakerId: id };
        },
      },
      newId: () => "90000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      parseSpeakerCsv,
    });
    return { repository, service };
  }

  it("refuses that row, counts the rest, and leaves the ledger ready for a retry", async () => {
    // `deleteProfile` is a fixture affordance; nothing in the product deletes a speaker today,
    // which is why this is driven here rather than through a command.
    const { repository, service } = setup(async (store) => store.deleteProfile(profileId));

    const first = await service.importSpeakers(
      organizer,
      { eventId, csv, commit: true },
      "correlation",
    );

    // Refused and named, rather than skipped and counted.
    expect(first.rows[0]?.errors).toContain("Speaker record removed during import; retry this row");
    // Not fatal to the batch: the second row landed.
    expect(first.imported).toBe(1);
    // The ledger is what makes the refusal safe — still `pending`, so re-running the same file
    // re-attempts exactly this row.
    expect(await repository.findSpeakerImport(eventId, "sam@example.test")).toBe("pending");
    expect(await repository.findSpeakerImport(eventId, "alex@example.test")).toBe("complete");
  });

  it("refuses the row when the ledger's own mark of completion matches nothing", async () => {
    // The profile survives; the ledger row does not. A row counted as imported that nothing
    // recorded as complete is a claim the store does not support, so it is refused the same way.
    const { repository, service } = setup(async (store) =>
      store.deleteSpeakerImport(eventId, "sam@example.test"),
    );

    const result = await service.importSpeakers(
      organizer,
      { eventId, csv, commit: true },
      "correlation",
    );

    expect(result.rows[0]?.errors).toContain(
      "Speaker record removed during import; retry this row",
    );
    expect(result.imported).toBe(1);
    expect((await repository.findProfile(profileId))?.workflowStatus).toBe("ready");
  });
});
