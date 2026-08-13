// @acceptance ACC-AGENDA
/*
 * Drift in `agenda_session_schedules`, detected and repaired (issue #169, closing `GAP-024`).
 *
 * The state under test is one no supported code path produces. `D1AgendaRepository.publish`
 * maintains the derived table inside the publication's own batch, so reaching a stale table means
 * writing the history behind the fold's back — which is exactly what the deploy window does, and
 * what any future direct writer of `agenda_publications` would do. Both repositories therefore
 * expose one method for it, and the tests below drive real divergence rather than a stub that
 * reports one.
 *
 * The two scenarios that carry the weight are the two ends of `GAP-024`, and they fail in opposite
 * directions: a *phantom* row invites speakers to a session the programme does not schedule, and a
 * *stale revision* suppresses the invitation that puts a returning talk back on their calendar.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { sweepDriftedSchedules } from "../src/application/agenda/schedule-reconciliation";
import {
  compareSessionScheduleRevisions,
  isScheduleInSync,
  type AgendaDraft,
  type SessionScheduleRevision,
} from "../src/domain/agenda/agenda";

const eventId = "00000000-0000-4000-8000-000000000001";

const board = (placed: boolean, slotId = "slot-9"): AgendaDraft => ({
  eventId,
  rooms: [{ id: "room-main", name: "Main stage" }],
  tracks: [{ id: "track-web", name: "Web", color: "#5b5bd6" }],
  slots: [
    { id: "slot-9", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
    { id: "slot-10", startsAt: "2026-09-01T17:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z" },
  ],
  sessions: [{ id: "session-1", title: "One", speakerIds: ["speaker-1"] }],
  placements: placed
    ? [
        {
          id: "placement-1",
          sessionId: "session-1",
          roomId: "room-main",
          trackId: "track-web",
          slotId,
        },
      ]
    : [],
});

const publication = (version: number, placed: boolean, slotId?: string): PublishedSchedule => ({
  eventId,
  version,
  publishedAt: `2026-08-1${version}T10:00:00.000Z`,
  publishedBy: "organizer",
  agenda: board(placed, slotId),
});

const revision = (fields: Partial<SessionScheduleRevision> = {}): SessionScheduleRevision => ({
  startsAt: "2026-09-01T16:00:00.000Z",
  endsAt: "2026-09-01T17:00:00.000Z",
  location: "Main stage",
  revision: 1,
  revisedAt: "2026-08-11T10:00:00.000Z",
  ...fields,
});

describe("comparing stored revisions against a replay", () => {
  it("separates the three ways they can differ", () => {
    const drift = compareSessionScheduleRevisions(
      new Map([
        ["kept", revision()],
        ["phantom", revision()],
        ["moved", revision({ startsAt: "2026-09-01T18:00:00.000Z" })],
      ]),
      new Map([
        ["kept", revision()],
        ["missing", revision()],
        ["moved", revision()],
      ]),
    );
    expect(drift.missing).toEqual(["missing"]);
    expect(drift.phantom).toEqual(["phantom"]);
    expect(drift.divergent.map(({ sessionId }) => sessionId)).toEqual(["moved"]);
    expect(drift.divergent[0]?.stored.startsAt).toBe("2026-09-01T18:00:00.000Z");
    expect(drift.divergent[0]?.replayed.startsAt).toBe("2026-09-01T16:00:00.000Z");
    expect(isScheduleInSync(drift)).toBe(false);
  });

  /*
   * Every field, not only `revision`. Three of the five decide what a calendar client renders and
   * the fourth is written into the delivery's stored ref beside the revision, so a comparison that
   * skipped any of them would report "in sync" for a table that mails the wrong hour or the wrong
   * room — which is the milder of `GAP-024`'s cases but is still wrong mail.
   */
  it.each([
    ["startsAt", { startsAt: "2026-09-01T18:00:00.000Z" }],
    ["endsAt", { endsAt: "2026-09-01T19:00:00.000Z" }],
    ["location", { location: "Workshop lab" }],
    ["revision", { revision: 4 }],
    ["revisedAt", { revisedAt: "2026-08-12T10:00:00.000Z" }],
  ])("notices a stale %s", (_field, difference) => {
    const drift = compareSessionScheduleRevisions(
      new Map([["session-1", revision(difference)]]),
      new Map([["session-1", revision()]]),
    );
    expect(drift.divergent).toHaveLength(1);
  });

  it("reports agreement as agreement", () => {
    const drift = compareSessionScheduleRevisions(
      new Map([["session-1", revision()]]),
      new Map([["session-1", revision()]]),
    );
    expect(isScheduleInSync(drift)).toBe(true);
    expect(drift).toEqual({ missing: [], phantom: [], divergent: [] });
  });
});

describe("a publication written without maintaining the derived table", () => {
  it("leaves a phantom row, and the next read removes it", async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual(["session-1"]);

    // The deploy window: the old Worker commits a publication that unplaces the session, and
    // knows nothing about the table that records where sessions sit.
    await repository.recordUnmaintainedPublication(publication(2, false));

    const before = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(before.drift.phantom).toEqual(["session-1"]);
    expect(before.repaired).toBe(false);
    // A read-only check changes nothing, or an operator could only ever ask once.
    expect(
      (await repository.reconcileSessionSchedules(eventId, { repair: false })).drift.phantom,
    ).toEqual(["session-1"]);

    // Nothing else had to be asked. Reading the schedule is what repairs it.
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual([]);
    const after = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(isScheduleInSync(after.drift)).toBe(true);
    expect(after.materializedWatermark).toBe(2);
  });

  /*
   * `GAP-024`'s suppression case, which is the failure #136 exists to prevent.
   *
   * A session placed at v1 and invited with ref `1|…`; a missed publication at v2 unplaces it;
   * v3 places it back at the identical hour. The replay says revision 3 — absence resets — and the
   * REQUEST that puts the talk back on the speaker's calendar goes out. A table that folded v3
   * over the stale v1 row would compute "unchanged", keep revision 1, match the ref already
   * stored, and send nothing.
   */
  it("does not fold a missed publication through into the next one", async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    await repository.recordUnmaintainedPublication(publication(2, false));
    expect(await repository.publish(publication(3, true))).toBe("committed");

    const revisions = await repository.sessionScheduleRevisions(eventId);
    expect(revisions.get("session-1")?.revision).toBe(3);
    expect(revisions.get("session-1")?.revisedAt).toBe("2026-08-13T10:00:00.000Z");
    expect(
      isScheduleInSync(
        (await repository.reconcileSessionSchedules(eventId, { repair: false })).drift,
      ),
    ).toBe(true);
  });

  it("reports how much history the answer cost", async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    await repository.recordUnmaintainedPublication(publication(2, false));
    const report = await repository.reconcileSessionSchedules(eventId, { repair: true });
    expect(report.publications).toBe(2);
    expect(report.publicationWatermark).toBe(2);
    expect(report.repaired).toBe(true);
  });
});

describe("the sweep", () => {
  const drifted = async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    await repository.recordUnmaintainedPublication(publication(2, false));
    return repository;
  };

  it("repairs every drifted event it takes and reports each one", async () => {
    const repository = await drifted();
    const onRepair = vi.fn();
    expect(await sweepDriftedSchedules({ schedules: repository, onRepair })).toEqual({
      scanned: 1,
      repaired: 1,
      failed: 0,
    });
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(onRepair.mock.calls[0]?.[0]?.drift.phantom).toEqual(["session-1"]);
    // A repair is not routine: a healthy deployment sweeps nothing, forever, which is what makes
    // one reported repair a signal rather than noise.
    expect(await sweepDriftedSchedules({ schedules: repository, onRepair })).toEqual({
      scanned: 0,
      repaired: 0,
      failed: 0,
    });
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("takes no more events than it is allowed to", async () => {
    const repository = await drifted();
    expect(await repository.driftedEvents(0)).toEqual([]);
    expect(await sweepDriftedSchedules({ schedules: repository }, 0)).toEqual({
      scanned: 0,
      repaired: 0,
      failed: 0,
    });
  });

  /*
   * One unrepairable event must not protect every other event's drift from being fixed. The
   * failure is reported rather than swallowed, and the event stays flagged, so the next tick tries
   * it again and the observer sees it every minute — the correct amount of noise for something
   * genuinely broken.
   */
  it("carries on past an event it cannot repair, and says so", async () => {
    const onFailure = vi.fn();
    const result = await sweepDriftedSchedules({
      schedules: {
        driftedEvents: async () => ["broken", "sound"],
        reconcileSessionSchedules: async (id: string) => {
          if (id === "broken") throw new Error("schedule_json is not parseable");
          return {
            eventId: id,
            publicationWatermark: 2,
            materializedWatermark: 2,
            publications: 2,
            drift: { missing: [], phantom: [], divergent: [] },
            repaired: true,
          };
        },
      },
      onFailure,
    });
    expect(result).toEqual({ scanned: 2, repaired: 1, failed: 1 });
    expect(onFailure).toHaveBeenCalledWith({
      eventId: "broken",
      error: "schedule_json is not parseable",
    });
  });
});
