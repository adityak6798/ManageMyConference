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

  /*
   * One kind at a time, because the three-at-once case above cannot tell the clauses apart: with
   * every list non-empty, any single clause of `isScheduleInSync` can be dropped and the suite
   * stays green. The `missing` clause is the one that matters most to lose — a row deleted
   * straight out of `agenda_session_schedules` leaves the watermark undisturbed, so the on-demand
   * replay is the *only* thing that can find it, and a soundness test blind to `missing` would
   * report the event healthy and decline to repair it.
   */
  it.each([
    ["missing", new Map(), new Map([["session-1", revision()]])],
    ["phantom", new Map([["session-1", revision()]]), new Map()],
    [
      "divergent",
      new Map([["session-1", revision({ revision: 9 })]]),
      new Map([["session-1", revision()]]),
    ],
  ] as const)("is not in sync on %s alone", (_kind, stored, replayed) => {
    expect(isScheduleInSync(compareSessionScheduleRevisions(stored, replayed))).toBe(false);
  });

  /*
   * Sorted, because a report is meant to be pasted into an issue and compared with the next one.
   * `Map` iteration follows insertion order, so without the sort two reconciliations of the same
   * divergence would list the same sessions in whatever order storage happened to return them.
   */
  it("orders every list, so two reports of one divergence read identically", () => {
    const drift = compareSessionScheduleRevisions(
      new Map([
        ["s-c", revision()],
        ["s-a", revision()],
        ["s-d", revision({ revision: 9 })],
        ["s-b", revision({ revision: 9 })],
      ]),
      new Map([
        ["s-f", revision()],
        ["s-e", revision()],
        ["s-d", revision()],
        ["s-b", revision()],
      ]),
    );
    expect(drift.phantom).toEqual(["s-a", "s-c"]);
    expect(drift.missing).toEqual(["s-e", "s-f"]);
    expect(drift.divergent.map(({ sessionId }) => sessionId)).toEqual(["s-b", "s-d"]);
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
    expect(before.inSync).toBe(false);
    expect(before.repaired).toBe(false);
    // A read-only check changes nothing, or an operator could only ever ask once.
    expect(
      (await repository.reconcileSessionSchedules(eventId, { repair: false })).drift.phantom,
    ).toEqual(["session-1"]);

    // Nothing else had to be asked. Reading the schedule is what repairs it.
    expect([...(await repository.sessionScheduleRevisions(eventId)).keys()]).toEqual([]);
    const after = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(isScheduleInSync(after.drift)).toBe(true);
    expect(after.inSync).toBe(true);
    // Two writes to this event's history — the seeded publication and the unmaintained one — so
    // the watermark reads 2. It counts writes rather than versions, because two writes can carry
    // the same version and the question is whether anything happened at all.
    expect(after.materializedWatermark).toBe(2);
  });

  /*
   * Rows that already agree, under a watermark that does not say so, are **not** in sync.
   *
   * This is the state migration `1602` deliberately leaves behind for every already-published
   * event: it will not claim that `1601` caught a publication landing between the two migrations.
   * The distinction matters on the wire — an earlier version derived `inSync` from the drift lists
   * alone and answered `true` here, while the reconciler kept queueing the event and a `POST`
   * answered `repaired: true` for it.
   */
  it("treats correct rows under an unclaimed watermark as needing a repair, not as sound", async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    repository.unclaimWatermark(eventId);

    const found = await repository.reconcileSessionSchedules(eventId, { repair: false });
    expect(found.drift).toEqual({ missing: [], phantom: [], divergent: [] });
    expect(found.inSync).toBe(false);
    expect(found.materializedWatermark).toBeNull();
    expect(await repository.driftedEvents(10)).toEqual([eventId]);

    const repaired = await repository.reconcileSessionSchedules(eventId, { repair: true });
    // The settling repair is the one an operator must be able to tell from a real divergence, and
    // all three counts being zero is what says so.
    expect(repaired.repaired).toBe(true);
    expect(repaired.drift).toEqual({ missing: [], phantom: [], divergent: [] });
    expect((await repository.reconcileSessionSchedules(eventId, { repair: false })).inSync).toBe(
      true,
    );
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
    expect(report.inSync).toBe(false);
    expect(report.repaired).toBe(true);
  });
});

describe("the sweep", () => {
  const drifted = async () => {
    const repository = new MemoryAgendaRepository([board(true)], [publication(1, true)]);
    await repository.recordUnmaintainedPublication(publication(2, false));
    return repository;
  };

  it("repairs every drifted event it takes, and finds nothing on the next tick", async () => {
    const repository = await drifted();
    expect(await sweepDriftedSchedules({ schedules: repository })).toEqual({
      scanned: 1,
      repaired: 1,
      contended: 0,
      failed: 0,
    });
    // Once repaired the event leaves the index, so a settled deployment sweeps nothing — which is
    // what makes a reported repair a signal rather than noise.
    expect(await sweepDriftedSchedules({ schedules: repository })).toEqual({
      scanned: 0,
      repaired: 0,
      contended: 0,
      failed: 0,
    });
  });

  /*
   * A drifted event that neither repaired nor threw is contention, and it is silent everywhere
   * else: the repair observer only fires on success, `onFailure` only on a throw. Counting it is
   * the only way an event being published faster than its history can be walked reaches anybody.
   */
  it("counts a drifted event that declined to repair, which nothing else reports", async () => {
    const onFailure = vi.fn();
    const onContention = vi.fn();
    expect(
      await sweepDriftedSchedules({
        schedules: {
          driftedEvents: async () => ["contended"],
          reconcileSessionSchedules: async (id: string) => ({
            eventId: id,
            publicationWatermark: 9,
            materializedWatermark: 4,
            publications: 9,
            drift: { missing: [], phantom: ["session-1"], divergent: [] },
            inSync: false,
            repaired: false,
          }),
        },
        onFailure,
        onContention,
      }),
    ).toEqual({ scanned: 1, repaired: 0, contended: 1, failed: 0 });
    expect(onFailure).not.toHaveBeenCalled();
    // Named, not merely counted: a count cannot be acted on.
    expect(onContention).toHaveBeenCalledWith({ eventId: "contended" });
  });

  /*
   * And an event somebody else healed is not contention.
   *
   * The drifted list is read once and its entries are reconciled one at a time, so a read or a
   * publication can heal an event in between — which is the *expected* path for most drift, and
   * busiest while `1602`'s backfill settles. Counting that as contention would make the tick warn
   * about an event that lost no race and is not flagged.
   */
  it("does not report an event that was healed between the listing and the repair", async () => {
    const onContention = vi.fn();
    expect(
      await sweepDriftedSchedules({
        schedules: {
          driftedEvents: async () => ["healed"],
          reconcileSessionSchedules: async (id: string) => ({
            eventId: id,
            publicationWatermark: 4,
            materializedWatermark: 4,
            publications: 4,
            drift: { missing: [], phantom: [], divergent: [] },
            inSync: true,
            repaired: false,
          }),
        },
        onContention,
      }),
    ).toEqual({ scanned: 1, repaired: 0, contended: 0, failed: 0 });
    expect(onContention).not.toHaveBeenCalled();
  });

  it("takes no more events than it is allowed to", async () => {
    const repository = await drifted();
    expect(await repository.driftedEvents(0)).toEqual([]);
    expect(await sweepDriftedSchedules({ schedules: repository }, 0)).toEqual({
      scanned: 0,
      repaired: 0,
      contended: 0,
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
            inSync: false,
            repaired: true,
          };
        },
      },
      onFailure,
    });
    expect(result).toEqual({ scanned: 2, repaired: 1, contended: 0, failed: 1 });
    expect(onFailure).toHaveBeenCalledWith({
      eventId: "broken",
      error: "schedule_json is not parseable",
    });
  });
});
