// @acceptance ACC-AGENDA
/**
 * Generated drafts, the criteria library and availability windows against a real migrated D1.
 *
 * Three things are only true here.
 *
 * **The board revision is the board's own.** `boardRevision` reads the counter the board's
 * optimistic writes already advance, so "has the board moved since this draft was generated" is
 * answered by the same number every other writer maintains — including the ones that know nothing
 * about generation.
 *
 * **The library and the availability set are whole-set replacements.** Each is one arrangement the
 * organizer confirmed, and an upsert would leave behind whatever they removed. D1 applies a batch
 * atomically, so an event never holds half a library.
 *
 * **The table refuses what the service refuses.** A criterion nothing implements and a window that
 * ends before it starts are both refused at the table, so a writer that went round the service
 * still cannot store a priority nobody applies or a window that silently refuses every cell.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1AgendaGenerationRepository,
  type GenerationDatabasePort,
} from "../src/adapters/persistence/d1-agenda-generation";
import type { GeneratedDraft } from "../src/application/agenda/generation-service";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const DRAFT = "00000000-0000-4000-8000-0000000000c0";
const NOW = "2026-08-14T09:00:00.000Z";

const draftOf = (over: Partial<GeneratedDraft> = {}): GeneratedDraft => ({
  id: DRAFT,
  eventId: DEMO_EVENT,
  name: "First pass",
  boardRevision: 3,
  criteria: [{ criterion: "prefer-earlier-slots", position: 0, enabled: true }],
  placements: [
    { id: "generated-a", sessionId: "a", roomId: "hall-a", trackId: "main", slotId: "slot-1" },
  ],
  unplaced: [
    {
      sessionId: "b",
      title: "Beta",
      blockedBy: "respect-speaker-availability",
      reason: "Every remaining slot falls outside a speaker's availability.",
    },
  ],
  generatedBy: "seed-organizer",
  generatedAt: NOW,
  status: "proposed",
  acceptedAt: null,
  ...over,
});

describe("agenda generation against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "agenda-generation" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as GenerationDatabasePort;
    return { database, repository: new D1AgendaGenerationRepository(database) };
  }

  it("round-trips a draft with its criteria, placements and explanations", async () => {
    const { repository } = await stack();
    await repository.createDraft(draftOf());
    const stored = await repository.findDraft(DEMO_EVENT, DRAFT);
    expect(stored?.placements).toHaveLength(1);
    // The explanation survives, because "why was Beta left out" is asked after the fact.
    expect(stored?.unplaced[0]).toMatchObject({ blockedBy: "respect-speaker-availability" });
    expect(stored?.criteria).toEqual([
      { criterion: "prefer-earlier-slots", position: 0, enabled: true },
    ]);
    // Scoped by event: another event's id finds nothing rather than the row.
    expect(await repository.findDraft("00000000-0000-4000-8000-000000000002", DRAFT)).toBeNull();
  });

  it("reads the board's own revision counter", async () => {
    const { database, repository } = await stack();
    // The seed leaves a board for the demo event; its revision is whatever its writes reached.
    const before = await repository.boardRevision(DEMO_EVENT);
    await database
      .prepare("UPDATE agenda_drafts SET revision = revision + 1 WHERE event_id = ?")
      .bind(DEMO_EVENT)
      .run();
    expect(await repository.boardRevision(DEMO_EVENT)).toBe(before + 1);
    // An event with no board row reads as zero rather than failing.
    expect(await repository.boardRevision("00000000-0000-4000-8000-0000000000ff")).toBe(0);
  });

  it("marks a draft accepted with its instant, and discarded without one", async () => {
    const { repository } = await stack();
    await repository.createDraft(draftOf());
    expect(await repository.setDraftStatus(DEMO_EVENT, DRAFT, "accepted", NOW)).toBe(1);
    expect(await repository.findDraft(DEMO_EVENT, DRAFT)).toMatchObject({
      status: "accepted",
      acceptedAt: NOW,
    });
    // The table's CHECK ties the two together, so a discarded draft cannot keep an accepted-at.
    expect(await repository.setDraftStatus(DEMO_EVENT, DRAFT, "discarded", NOW)).toBe(1);
    expect(await repository.findDraft(DEMO_EVENT, DRAFT)).toMatchObject({
      status: "discarded",
      acceptedAt: null,
    });
  });

  it("replaces the criteria library whole rather than merging into it", async () => {
    const { repository } = await stack();
    // Never configured reads as null, which the service turns into the defaults — distinct from
    // an empty library, which nothing can produce.
    expect(await repository.listCriteria(DEMO_EVENT)).toBeNull();
    await repository.replaceCriteria(DEMO_EVENT, [
      { criterion: "prefer-earlier-slots", position: 0, enabled: true },
      { criterion: "balance-room-load", position: 1, enabled: false },
    ]);
    expect(await repository.listCriteria(DEMO_EVENT)).toEqual([
      { criterion: "prefer-earlier-slots", position: 0, enabled: true },
      { criterion: "balance-room-load", position: 1, enabled: false },
    ]);
    await repository.replaceCriteria(DEMO_EVENT, [
      { criterion: "keep-track-together", position: 0, enabled: true },
    ]);
    // Whatever the organizer removed is gone, rather than surviving underneath.
    expect(await repository.listCriteria(DEMO_EVENT)).toEqual([
      { criterion: "keep-track-together", position: 0, enabled: true },
    ]);
  });

  it("refuses a criterion nothing implements and a window that ends before it starts", async () => {
    const { database, repository } = await stack();
    await expect(
      database
        .prepare(
          "INSERT INTO agenda_generation_criteria (event_id, criterion, position, enabled) VALUES (?,?,0,1)",
        )
        .bind(DEMO_EVENT, "put-the-good-ones-first")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
    await expect(
      database
        .prepare(
          "INSERT INTO agenda_speaker_availability (event_id, speaker_id, starts_at, ends_at, kind, note) VALUES (?,?,?,?,?,'')",
        )
        .bind(
          DEMO_EVENT,
          "ada",
          "2026-09-02T09:00:00.000Z",
          "2026-09-01T09:00:00.000Z",
          "available",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
    // And the good case round-trips.
    await repository.replaceAvailability(DEMO_EVENT, [
      {
        speakerId: "ada",
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-01T12:00:00.000Z",
        kind: "unavailable",
      },
    ]);
    expect(await repository.listAvailability(DEMO_EVENT)).toEqual([
      {
        speakerId: "ada",
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-01T12:00:00.000Z",
        kind: "unavailable",
      },
    ]);
  });
});
