// @acceptance ACC-INTEGRATION
// @spec PRD-INT-001 PORT-ACCELEVENTS
import { describe, expect, it } from "vitest";
import { parseSpeakerCsv } from "../src/adapters/content/parse-speaker-csv";
import { MemoryAccelEventsSyncRuns } from "../src/adapters/persistence/d1-accelevents-sync-runs";
import {
  FIXTURE_ATTENDEE_RESPONSE,
  FixtureAccelEventsRegistrations,
} from "../src/adapters/providers/accelevents-registration";
import {
  type AccelEventsRegistrant,
  AccelEventsSyncService,
  AccelEventsUnavailableError,
} from "../src/application/communications/accelevents-sync";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["events:read", "content:manage"]) },
  ],
  capabilities: new Set(["content:manage"]),
};

/**
 * A stand-in for content's import command that behaves the way the real one does in the respect
 * this feature depends on: an address it has already imported comes back marked `duplicate`, and
 * a preview changes nothing.
 */
function contentDouble() {
  const imported = new Set<string>();
  const csvSeen: string[] = [];
  return {
    imported,
    csvSeen,
    async importSpeakers(
      _actor: Actor | null,
      input: { eventId: string; csv: string; commit: boolean },
    ) {
      csvSeen.push(input.csv);
      const [, ...lines] = input.csv.split("\n").filter(Boolean);
      const rows = lines.map((line, index) => {
        // Only the fixture's shapes are parsed here; commas inside quoted fields are covered by
        // the round-trip assertion below rather than by this double.
        const [name = "", email = ""] = line.split(",");
        const clean = email.replaceAll('"', "").trim().toLowerCase();
        const errors = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? [] : ["Valid email is required"];
        const duplicate = imported.has(clean);
        if (input.commit && !errors.length && !duplicate) imported.add(clean);
        return {
          row: index + 2,
          name: name.replaceAll('"', ""),
          email: clean,
          duplicate,
          errors: duplicate ? ["Duplicate email"] : errors,
        };
      });
      return { rows };
    },
  };
}

function harness(registrants?: readonly AccelEventsRegistrant[]) {
  const content = contentDouble();
  const runs = new MemoryAccelEventsSyncRuns();
  const service = new AccelEventsSyncService({
    source: registrants
      ? { listRegistrants: async () => registrants }
      : new FixtureAccelEventsRegistrations(),
    content,
    runs,
    mode: "fixture",
    now: () => new Date("2026-08-12T09:00:00.000Z"),
  });
  return { service, content, runs };
}

describe("Accelevents registration sync", () => {
  it("keeps the fixture on the published attendee envelope (retrieved 2026-08-12)", async () => {
    expect(FIXTURE_ATTENDEE_RESPONSE.recordsFiltered).toBe(
      FIXTURE_ATTENDEE_RESPONSE.attendees.length,
    );
    expect(FIXTURE_ATTENDEE_RESPONSE.recordsTotal).toBe(FIXTURE_ATTENDEE_RESPONSE.attendees.length);
    expect(FIXTURE_ATTENDEE_RESPONSE.ticketTypeCountDtos).not.toHaveLength(0);
    for (const attendee of FIXTURE_ATTENDEE_RESPONSE.attendees)
      expect(attendee).toEqual(
        expect.objectContaining({
          attendeeId: expect.any(String),
          firstName: expect.any(String),
          lastName: expect.any(String),
          email: expect.any(String),
          barcode: expect.any(String),
          status: expect.any(String),
          ticketStatus: expect.any(String),
        }),
      );
    await expect(
      new FixtureAccelEventsRegistrations().listRegistrants(eventId),
    ).resolves.toHaveLength(FIXTURE_ATTENDEE_RESPONSE.recordsTotal);
  });

  it("predicts exactly what an apply will do and writes nothing", async () => {
    const test = harness();

    const preview = await test.service.sync(organizer, eventId, { commit: false }, "corr-1");
    expect(preview.preview).toBe(true);
    // The fixture roster is three usable registrants and one deliberately malformed address.
    expect(preview).toMatchObject({ total: 4, created: 3, skipped: 0, invalid: 1 });
    expect(test.content.imported.size).toBe(0);
    // A dry run is not a run: recording it would make "last sync" a claim about something that
    // did not happen.
    expect(await test.runs.find(eventId)).toBeNull();

    const applied = await test.service.sync(organizer, eventId, { commit: true }, "corr-2");
    // The prediction was accurate, which is the property that makes a dry run worth having.
    expect(applied).toMatchObject({ preview: false, total: 4, created: 3, skipped: 0, invalid: 1 });
    expect(test.content.imported.size).toBe(3);
  });

  it("converges on a second apply instead of importing everyone twice", async () => {
    const test = harness();
    await test.service.sync(organizer, eventId, { commit: true }, "corr-1");

    const again = await test.service.sync(organizer, eventId, { commit: true }, "corr-2");
    // Every registrant already present: reported as skipped, not as an error and not as a second
    // speaker. A converged sync must not look like a broken one.
    expect(again).toMatchObject({ total: 4, created: 0, skipped: 3, invalid: 1 });
    expect(test.content.imported.size).toBe(3);
    expect(again.rows.filter((row) => row.disposition === "skip").map((row) => row.errors)).toEqual(
      [[], [], []],
    );
  });

  it("carries the Accelevents reference through to the row and the profile", async () => {
    const test = harness();
    const report = await test.service.sync(organizer, eventId, { commit: false }, "corr-1");

    expect(report.rows[0]?.sourceRef).toBe("ae-reg-1001");
    // The identifier reaches content on the profile's custom fields, so an organizer looking at
    // an imported speaker can see where they came from without reading this feature's run log.
    expect(test.content.csvSeen[0]).toContain("accelEventsRef");
    expect(test.content.csvSeen[0]).toContain("ae-reg-1001");
  });

  /**
   * The CSV this hands content is read back by the parser content actually uses.
   *
   * The sync writes that CSV itself, so "the writer and the reader agree" is an assumption, not a
   * fact — and it is the assumption that fails silently: a mis-quoted name splits into two columns
   * and imports a person who does not exist, with every count still looking plausible.
   */
  it("round-trips hostile names and JSON through the parser content really uses", async () => {
    const registrants: AccelEventsRegistrant[] = [
      { sourceRef: "ae-1", name: "Ada, Countess of Lovelace", email: "ada@example.test" },
      { sourceRef: "ae-2", name: 'Grace "Amazing" Hopper', email: "grace@example.test" },
      {
        sourceRef: "ae-3",
        name: "Line\nBreak",
        email: "line@example.test",
        ticketType: "VIP, gold",
      },
    ];
    const test = harness(registrants);
    await test.service.sync(organizer, eventId, { commit: false }, "corr-1");

    const parsed = parseSpeakerCsv(test.content.csvSeen[0] ?? "");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => row.name)).toEqual([
      "Ada, Countess of Lovelace",
      'Grace "Amazing" Hopper',
      "Line\nBreak",
    ]);
    expect(parsed.rows.map((row) => row.email)).toEqual([
      "ada@example.test",
      "grace@example.test",
      "line@example.test",
    ]);
    // The provenance content stores has to survive too — it is JSON, which is all commas and
    // quotes, and content refuses a row whose custom fields will not parse.
    expect(parsed.rows.map((row) => JSON.parse(row.customFields ?? "{}"))).toEqual([
      { accelEventsRef: "ae-1" },
      { accelEventsRef: "ae-2" },
      { accelEventsRef: "ae-3", accelEventsTicket: "VIP, gold" },
    ]);
    expect(parsed.rows.every((row) => row.workflowStatus === "invited")).toBe(true);
  });

  it("records a failed run and refuses to invent a report when the platform is unreadable", async () => {
    const runs = new MemoryAccelEventsSyncRuns();
    const content = contentDouble();
    const service = new AccelEventsSyncService({
      source: {
        listRegistrants: async () => {
          throw new AccelEventsUnavailableError("PROVIDER_UNAVAILABLE:503");
        },
      },
      content,
      runs,
      mode: "live",
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    });

    await expect(
      service.sync(organizer, eventId, { commit: true }, "corr-1"),
    ).rejects.toBeInstanceOf(AccelEventsUnavailableError);
    // The failure is the thing the organizer surface reads, so it has to be durable.
    expect(await runs.find(eventId)).toMatchObject({
      outcome: "failed",
      errorCode: "PROVIDER_UNAVAILABLE:503",
      created: 0,
    });
    expect(content.imported.size).toBe(0);
  });

  it("does not record a failed dry run, because a dry run changes nothing", async () => {
    const runs = new MemoryAccelEventsSyncRuns();
    const service = new AccelEventsSyncService({
      source: {
        listRegistrants: async () => {
          throw new AccelEventsUnavailableError("PROVIDER_UNREACHABLE");
        },
      },
      content: contentDouble(),
      runs,
      mode: "live",
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    });
    await expect(service.sync(organizer, eventId, { commit: false }, "c")).rejects.toThrow();
    expect(await runs.find(eventId)).toBeNull();
  });

  it("refuses an actor without content:manage before contacting the platform", async () => {
    let reached = false;
    const service = new AccelEventsSyncService({
      source: {
        listRegistrants: async () => {
          reached = true;
          return [];
        },
      },
      content: contentDouble(),
      runs: new MemoryAccelEventsSyncRuns(),
      mode: "fixture",
      now: () => new Date(),
    });
    const speaker: Actor = {
      ...organizer,
      persona: "speaker",
      eventAccess: [{ eventId, role: "speaker", capabilities: new Set(["content:read"]) }],
      capabilities: new Set(["content:read"]),
    };
    await expect(service.sync(speaker, eventId, { commit: false }, "c")).rejects.toThrow(
      "content:manage",
    );
    await expect(service.sync(null, eventId, { commit: false }, "c")).rejects.toThrow();
    await expect(service.describe(speaker, eventId)).rejects.toThrow("content:manage");
    // An unauthorized caller must not be able to make this Worker call a third party, repeatedly,
    // on someone else's bill.
    expect(reached).toBe(false);
  });

  it("says which source answered, so a fixture count is never read as a live one", async () => {
    const test = harness();
    expect(await test.service.describe(organizer, eventId)).toEqual({
      mode: "fixture",
      direction: "inbound",
      lastRun: null,
    });
    await test.service.sync(organizer, eventId, { commit: true }, "corr-1");
    expect((await test.service.describe(organizer, eventId)).lastRun).toMatchObject({
      outcome: "succeeded",
      created: 3,
      invalid: 1,
    });
  });
});
