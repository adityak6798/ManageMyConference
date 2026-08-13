-- @spec PRD-AGD-001 PRD-SPK-002
--
-- The last meaningful per-session revision, maintained forward at publication time.
--
-- "When and where does the schedule in force put this session, and at which publication did that
-- last meaningfully change" was answered by replaying the entire publication history: every
-- `agenda_publications` row carries a complete board, and every one of them was transferred out
-- of D1 and parsed on every content workspace read that resolves session times — the organizer
-- content workspace and the speaker calendar-invite send both. The cost was
-- O(publications x board size) and grew without bound as an event was republished (issue #141).
--
-- The answer is now stored. It is written inside the same batch that commits the publication, so
-- it cannot outlive or precede the snapshot it describes, and the read is one indexed lookup of
-- at most one row per session.
--
-- `revision` is a publication version rather than a counter of its own, which is what makes it
-- comparable with the history and monotonic by construction. It is externally observable: #136
-- writes it into `calendar_invite_states.schedule_ref`, and a session whose revision differs
-- from what the replay produced would resend an invitation to every speaker already holding it.
-- The backfill below therefore has to agree with `nextSessionScheduleRevisions` exactly, for
-- pre-existing history as well as for anything published from here on.

CREATE TABLE agenda_session_schedules (
  event_id TEXT NOT NULL REFERENCES events(id),
  session_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  revised_at TEXT NOT NULL,
  PRIMARY KEY (event_id, session_id)
);

-- Backfill from the history this table replaces.
--
-- The same fold `nextSessionScheduleRevisions` performs in TypeScript, expressed over every
-- snapshot at once. Five things it has to reproduce, each mirroring a line of the domain rule:
--
--   * A placement whose slot the snapshot no longer holds yields nothing at all, rather than a
--     half-time — hence the inner join to `slots`, never an outer one.
--   * A room the snapshot no longer holds leaves the location empty and keeps the hour, hence
--     `COALESCE(..., '')` around the room lookup.
--   * Two placements of one session: the last one in array order wins, hence the ranking on
--     `placement_index DESC`. This is load-bearing, not defensive. `conflictsFor` only reaches
--     its `SESSION_OVERLAP` branch once two placements' slots actually overlap in time, so a
--     session placed twice in two *non-overlapping* slots raises no conflict and publishes
--     normally. Committed history can therefore contain one, and the two implementations have
--     to agree about which placement wins.
--   * `ordinal` is ranked over *all* publications, not only over those that placed something. A
--     published empty board makes every session absent, and a rank computed over `placed` would
--     skip it and read the absence as continuity.
--   * A gap in a session's own run of publications is an absence, and an absence resets: the
--     returning publication's version is the revision even when the hour is unchanged.
--
-- `IS NOT` rather than `<>` throughout. Belt and braces rather than load-bearing: `prev_*` is
-- NULL only on a partition's first row, which `prev_ordinal IS NULL` already catches, and
-- `location` cannot be NULL because of the COALESCE. Kept because the null-safe form stays
-- correct if a later reader adds a nullable column to the comparison.
--
-- The equivalence with the TypeScript fold is exact for every snapshot this system can store,
-- and conditional on `agendaResourcesSchema`, which has enforced unique room, track and slot
-- ids and non-empty names since the agenda's first commit. Where a snapshot to violate that,
-- the two would break the tie differently: SQLite's scalar subquery takes the first duplicate
-- id and TypeScript's `Map` takes the last. No write path can produce one.
WITH pubs AS (
  SELECT
    event_id,
    version,
    published_at,
    row_number() OVER (PARTITION BY event_id ORDER BY version) AS ordinal
  FROM agenda_publications
),
placed AS (
  SELECT
    p.event_id AS event_id,
    p.version AS version,
    json_extract(pl.value, '$.sessionId') AS session_id,
    json_extract(s.value, '$.startsAt') AS starts_at,
    json_extract(s.value, '$.endsAt') AS ends_at,
    COALESCE(
      (
        SELECT json_extract(r.value, '$.name')
        FROM json_each(p.schedule_json, '$.rooms') r
        WHERE json_extract(r.value, '$.id') = json_extract(pl.value, '$.roomId')
      ),
      ''
    ) AS location,
    pl.key AS placement_index
  FROM agenda_publications p
  JOIN json_each(p.schedule_json, '$.placements') pl
  JOIN json_each(p.schedule_json, '$.slots') s
    ON json_extract(s.value, '$.id') = json_extract(pl.value, '$.slotId')
),
last_wins AS (
  SELECT event_id, version, session_id, starts_at, ends_at, location
  FROM (
    SELECT
      placed.*,
      row_number() OVER (
        PARTITION BY event_id, version, session_id ORDER BY placement_index DESC
      ) AS recency
    FROM placed
  )
  WHERE recency = 1
),
ordered AS (
  SELECT
    lw.event_id AS event_id,
    lw.version AS version,
    lw.session_id AS session_id,
    lw.starts_at AS starts_at,
    lw.ends_at AS ends_at,
    lw.location AS location,
    pubs.ordinal AS ordinal,
    pubs.published_at AS published_at
  FROM last_wins lw
  JOIN pubs ON pubs.event_id = lw.event_id AND pubs.version = lw.version
),
changes AS (
  SELECT
    ordered.*,
    lag(ordinal) OVER w AS prev_ordinal,
    lag(starts_at) OVER w AS prev_starts_at,
    lag(ends_at) OVER w AS prev_ends_at,
    lag(location) OVER w AS prev_location
  FROM ordered
  WINDOW w AS (PARTITION BY event_id, session_id ORDER BY version)
),
meaningful AS (
  SELECT *
  FROM changes
  WHERE prev_ordinal IS NULL
     OR prev_ordinal IS NOT (ordinal - 1)
     OR prev_starts_at IS NOT starts_at
     OR prev_ends_at IS NOT ends_at
     OR prev_location IS NOT location
),
-- Only sessions the latest snapshot still places survive the fold; the rest were deleted from
-- the map by their absence and are simply "not scheduled".
in_force AS (
  SELECT lw.event_id AS event_id, lw.session_id AS session_id
  FROM last_wins lw
  WHERE lw.version = (
    SELECT MAX(q.version) FROM agenda_publications q WHERE q.event_id = lw.event_id
  )
),
-- The most recent meaningful change per session is the revision in force.
--
-- Ranked with a window rather than selected with `WHERE version = (SELECT MAX(...) FROM
-- meaningful ...)`. Both are near-linear in practice — measured under `node:sqlite` at 50
-- sessions a board, 100 to 1600 publications, the correlated form ran 454ms to 7081ms and this
-- one 387ms to 6845ms — so this is a choice of shape rather than a rescue. The window form is
-- linear because it makes one ranking pass; the correlated form is linear only while the
-- planner keeps flattening a subquery that re-derives the whole `meaningful` chain per
-- surviving row. This migration is the one statement here that runs against precisely the
-- unbounded history the change exists to stop replaying, so it should not depend on that.
latest AS (
  SELECT
    m.*,
    row_number() OVER (PARTITION BY m.event_id, m.session_id ORDER BY m.version DESC) AS recency
  FROM meaningful m
)
INSERT INTO agenda_session_schedules (
  event_id, session_id, starts_at, ends_at, location, revision, revised_at
)
SELECT l.event_id, l.session_id, l.starts_at, l.ends_at, l.location, l.version, l.published_at
FROM latest l
JOIN in_force f ON f.event_id = l.event_id AND f.session_id = l.session_id
WHERE l.recency = 1;
