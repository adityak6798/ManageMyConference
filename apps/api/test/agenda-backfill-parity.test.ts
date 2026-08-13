// @acceptance ACC-AGENDA
/*
 * Migration `1601`'s backfill against the rule it is supposed to reproduce, over generated input.
 *
 * The hand-built history in `d1-agenda-repository.integration.test.ts` proves the branches
 * somebody thought of. This proves the ones nobody did: the same fold expressed twice — once as
 * `nextSessionScheduleRevisions`, once as a CTE over every snapshot at once — has to agree on
 * every history, and a case-based test cannot establish that.
 *
 * It matters more here than it usually would. `revision` and `revisedAt` are already written into
 * `calendar_invite_states.schedule_ref` on deployed databases (issue #136), so a history where
 * the two disagree is a spurious calendar invitation resent to every speaker on that session at
 * deploy time — and `1601` is immutable once merged, so there is no second chance at it.
 *
 * Runs under `node:sqlite` rather than Miniflare, which is what makes a thousand databases
 * affordable in the unit suite. `tools/check-schema-drift.mjs` already relies on every migration
 * being executable there, so this adds no new constraint on what the SQL may use.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AgendaDraft,
  nextSessionScheduleRevisions,
  placedSessionTimes,
  type SessionScheduleRevision,
} from "../src/domain/agenda/agenda";

const MIGRATION = new URL("../migrations/1601_agenda_session_schedules.sql", import.meta.url);

/**
 * Split the migration into statements.
 *
 * `--` comments are dropped rather than carried, for the same reason `test/support/seeded-d1.ts`
 * drops them: an apostrophe in a comment ("a session's own run") otherwise opens a string
 * literal that swallows every quote after it. `1601` declares no trigger, so there is no
 * BEGIN/END body to protect and a split on `;` is sufficient.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const MIGRATION_STATEMENTS = statements(readFileSync(MIGRATION, "utf8"));

interface Publication {
  readonly version: number;
  readonly publishedAt: string;
  readonly agenda: AgendaDraft;
}

/** The rule, folded oldest-first — the same thing the write path does one publication at a time. */
function fold(publications: readonly Publication[]): ReadonlyMap<string, SessionScheduleRevision> {
  let revisions: ReadonlyMap<string, SessionScheduleRevision> = new Map();
  for (const publication of [...publications].sort((left, right) => left.version - right.version))
    revisions = nextSessionScheduleRevisions(revisions, publication);
  return revisions;
}

/** Apply `1601` to a scratch database holding `history`, and read back what it materialized. */
function backfill(
  histories: ReadonlyMap<string, readonly Publication[]>,
): Map<string, Map<string, SessionScheduleRevision>> {
  /*
   * Foreign keys off, and no rows in the tables `agenda_publications` and the new table point at.
   *
   * The backfill reads `agenda_publications` and writes `agenda_session_schedules`; it never
   * consults `events` or `users`, so their rows would be scaffolding that changes no result. They
   * are also another domain's tables, and this file is agenda-owned — populating them here would
   * be exactly the cross-domain reach `npm run context -- check` exists to catch, in a fixture
   * rather than in production code, which is the least useful place to be granted an exception.
   * The referenced tables are still declared so the DDL the migration runs against is real.
   */
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  database.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE agenda_publications (
      event_id TEXT NOT NULL REFERENCES events(id),
      version INTEGER NOT NULL CHECK (version > 0),
      published_at TEXT NOT NULL,
      published_by TEXT NOT NULL REFERENCES users(id),
      schedule_json TEXT NOT NULL,
      command_key TEXT,
      PRIMARY KEY (event_id, version)
    );
  `);
  const insertPublication = database.prepare(
    "INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (?, ?, ?, 'seed-organizer', ?)",
  );
  for (const [eventId, history] of histories)
    for (const publication of history)
      insertPublication.run(
        eventId,
        publication.version,
        publication.publishedAt,
        JSON.stringify(publication.agenda),
      );

  for (const statement of MIGRATION_STATEMENTS) database.exec(statement);

  const materialized = new Map<string, Map<string, SessionScheduleRevision>>();
  for (const row of database.prepare("SELECT * FROM agenda_session_schedules").all() as Array<
    Record<string, string | number>
  >) {
    const forEvent =
      materialized.get(String(row.event_id)) ?? new Map<string, SessionScheduleRevision>();
    forEvent.set(String(row.session_id), {
      startsAt: String(row.starts_at),
      endsAt: String(row.ends_at),
      location: String(row.location),
      revision: Number(row.revision),
      revisedAt: String(row.revised_at),
    });
    materialized.set(String(row.event_id), forEvent);
  }
  database.close();
  return materialized;
}

/** Deterministic PRNG, so a failing case is reproducible from the seed the failure names. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const SESSIONS = ["session-a", "session-b", "session-c"];
/** `room-missing` is never declared, so a placement naming it exercises the empty location. */
const ROOM_IDS = ["room-main", "room-lab", "room-missing"];
/** `slot-missing` is never declared, so a placement naming it must yield nothing at all. */
const SLOT_IDS = ["slot-0900", "slot-0900-twin", "slot-1000", "slot-missing"];

/**
 * A history built to land on the awkward cases far more often than a real event would.
 *
 * Rooms and slots come and go, `slot-0900-twin` carries the same hour as `slot-0900` under a
 * different id, rooms are occasionally renamed, sessions are dropped and returned, boards are
 * sometimes published empty, and a session is sometimes placed twice.
 */
function generateHistory(next: () => number, eventId: string): Publication[] {
  const publications: Publication[] = [];
  const count = 1 + Math.floor(next() * 9);
  for (let version = 1; version <= count; version += 1) {
    const rooms = ["room-main", "room-lab"]
      .filter(() => next() > 0.2)
      .map((id) => ({ id, name: next() > 0.7 ? `${id} renamed` : `${id} name` }));
    const slots = [
      { id: "slot-0900", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
      {
        id: "slot-0900-twin",
        startsAt: "2026-09-01T16:00:00.000Z",
        endsAt: "2026-09-01T17:00:00.000Z",
      },
      { id: "slot-1000", startsAt: "2026-09-01T17:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z" },
    ].filter(() => next() > 0.15);
    const placements = [];
    for (const sessionId of SESSIONS) {
      const copies = next() < 0.45 ? 0 : next() < 0.85 ? 1 : 2;
      for (let copy = 0; copy < copies; copy += 1)
        placements.push({
          id: `placement-${sessionId}-${copy}-${version}`,
          sessionId,
          roomId: ROOM_IDS[Math.floor(next() * ROOM_IDS.length)] as string,
          trackId: "track-platform",
          slotId: SLOT_IDS[Math.floor(next() * SLOT_IDS.length)] as string,
        });
    }
    publications.push({
      version,
      publishedAt: `2026-08-12T00:00:${String(version).padStart(2, "0")}.000Z`,
      agenda: {
        eventId,
        rooms,
        tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
        slots,
        sessions: [],
        placements,
      },
    });
  }
  return publications;
}

/**
 * The two events one seed produces, drawn from one stream.
 *
 * Shared by both tests below, so the histories the guard measures are exactly the histories the
 * parity test ran. Re-deriving them separately is how a guard drifts into describing a corpus
 * nobody actually tested.
 */
function historiesForSeed(seed: number): Map<string, Publication[]> {
  const next = random(seed);
  return new Map([
    ["event-1", generateHistory(next, "event-1")],
    ["event-2", generateHistory(next, "event-2")],
  ]);
}

/** Where one placement resolves, or `null` when its slot is not in the snapshot. */
function tripleFor(
  agenda: AgendaDraft,
  placement: AgendaDraft["placements"][number],
): string | null {
  const slot = agenda.slots.find((candidate) => candidate.id === placement.slotId);
  if (!slot) return null;
  const room = agenda.rooms.find((candidate) => candidate.id === placement.roomId);
  return `${slot.startsAt}|${slot.endsAt}|${room?.name ?? ""}`;
}

describe("migration 1601 backfill", () => {
  /**
   * The headline: two implementations of one rule, over a thousand generated histories.
   *
   * One database per case rather than one shared one, so a case cannot inherit rows from the
   * case before it — the backfill inserts, it does not reconcile.
   */
  /*
   * The generous timeout is about load, not about this test. It folds 2,000 histories twice and
   * takes ~2.4 s alone — comfortably inside the 5 s default until the suite runs beside two other
   * checkouts, at which point it is the one test in `apps/api` that intermittently times out.
   * Raising the bound rather than shrinking the corpus keeps the property it proves: a smaller
   * generator was already shown to stop discriminating the two implementations (issue #141).
   */
  it("agrees with nextSessionScheduleRevisions on every generated history", {
    timeout: 30_000,
  }, () => {
    const disagreements: string[] = [];
    // Compared as key-sorted entry lists: the answer is a map, so its iteration order is not
    // part of it, and comparing stringified objects would fail on an irrelevant ordering change.
    const sorted = (revisions: ReadonlyMap<string, SessionScheduleRevision>) =>
      [...revisions].sort(([left], [right]) => left.localeCompare(right));
    for (let seed = 1; seed <= 1000; seed += 1) {
      // Two events per case, so a backfill that leaked across the partition would show up.
      const histories = historiesForSeed(seed);
      const materialized = backfill(histories);
      for (const [eventId, history] of histories) {
        const expected = sorted(fold(history));
        const actual = sorted(materialized.get(eventId) ?? new Map());
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          disagreements.push(
            `seed ${seed}, ${eventId}:\n  SQL  ${JSON.stringify(actual)}\n  fold ${JSON.stringify(expected)}`,
          );
      }
    }

    expect(disagreements).toEqual([]);
  });

  /**
   * The generator has to reach the cases that actually *discriminate*, not merely their shapes.
   *
   * Counting double placements is not enough. Two placements of one session tell the two
   * implementations apart only when they resolve to **different** `(startsAt, endsAt, location)`
   * triples, because that is the only time picking the wrong one changes an answer. A removed
   * room is the same: it discriminates only while the session is still placed by the *final*
   * publication, since a history that later restores the room computes the empty location
   * without ever storing it.
   *
   * Both of those were real gaps rather than hypotheticals. A review found that reversing the
   * placement ranking and removing the room-name `COALESCE` each left the entire suite green,
   * precisely because the fixtures had the shapes without the discriminating versions of them.
   * Asserting shapes would let an edit to the probabilities put that back unnoticed.
   */
  it("generates the histories that actually discriminate the two implementations", () => {
    let emptyBoards = 0;
    let danglingSlots = 0;
    let returnsAfterAbsence = 0;
    /** Double placements whose copies resolve differently — the only kind a bad ranking fails. */
    let discriminatingDoubles = 0;
    /** Sessions in force at the end with an empty location — the only kind a dropped COALESCE fails. */
    let inForceEmptyLocations = 0;

    for (let seed = 1; seed <= 1000; seed += 1) {
      for (const [, history] of historiesForSeed(seed)) {
        const placedPerVersion = history.map(
          (publication) => new Set(placedSessionTimes(publication.agenda).keys()),
        );
        for (const publication of history) {
          const slotIds = new Set(publication.agenda.slots.map((slot) => slot.id));
          if (publication.agenda.placements.length === 0) emptyBoards += 1;
          for (const placement of publication.agenda.placements)
            if (!slotIds.has(placement.slotId)) danglingSlots += 1;
          for (const sessionId of SESSIONS) {
            const resolved = publication.agenda.placements
              .filter((placement) => placement.sessionId === sessionId)
              .map((placement) => tripleFor(publication.agenda, placement))
              .filter((triple): triple is string => triple !== null);
            if (new Set(resolved).size > 1) discriminatingDoubles += 1;
          }
        }
        const final = history.at(-1);
        if (final)
          for (const [, placed] of placedSessionTimes(final.agenda))
            if (placed.location === "") inForceEmptyLocations += 1;
        for (const sessionId of SESSIONS)
          for (let index = 2; index < placedPerVersion.length; index += 1)
            if (
              placedPerVersion[index]?.has(sessionId) &&
              !placedPerVersion[index - 1]?.has(sessionId) &&
              placedPerVersion[index - 2]?.has(sessionId)
            )
              returnsAfterAbsence += 1;
      }
    }

    // Floors rather than `> 0`, so a probability edit that merely made a case rare would show up
    // as a failure here rather than as a quietly weaker corpus.
    expect(emptyBoards).toBeGreaterThan(100);
    expect(danglingSlots).toBeGreaterThan(100);
    expect(discriminatingDoubles).toBeGreaterThan(100);
    expect(inForceEmptyLocations).toBeGreaterThan(100);
    expect(returnsAfterAbsence).toBeGreaterThan(100);
  });
});
