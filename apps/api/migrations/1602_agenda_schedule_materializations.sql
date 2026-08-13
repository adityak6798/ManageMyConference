-- @spec PRD-AGD-001 PRD-SPK-002
--
-- Whether `agenda_session_schedules` still describes the publication history it is derived from.
--
-- Issue #141 replaced an unbounded replay of `agenda_publications` with a stored answer in
-- `agenda_session_schedules`, maintained inside the batch that commits each publication. The
-- replay was self-correcting by construction — it recomputed from the immutable snapshots on
-- every read, so a wrong answer was not representable. The stored form gives that up, and
-- `GAP-024` recorded the two ways it can silently diverge:
--
--   * the deploy window, where `migrate:remote` runs before the Worker is uploaded, so for the
--     length of a web build the *old* Worker commits publications without maintaining the table;
--   * any other direct writer of `agenda_publications` — an import, a repair script, a fixture —
--     since "every writer also maintains the derived table" was convention and nothing enforced it.
--
-- The consequences are not symmetric and neither is small (issue #169). A publication the table
-- missed can leave a **phantom row** for a session the programme no longer schedules, which the
-- speaker calendar send reads as a real placement and mails an invitation for; and it can leave a
-- **stale revision** on a session that left and returned, which compares equal to the ref already
-- in `calendar_invite_states` and suppresses the REQUEST that puts the talk back on a speaker's
-- calendar — verbatim the regression #136 exists to prevent. One missed publication can do both,
-- to different sessions, at once.
--
-- What this migration adds is the thing that was missing: a fact, maintained by the database
-- itself, that says whether the derived table is still current.
--
--   `publication_watermark`  advanced by a trigger on *every* write to `agenda_publications`,
--                            whoever performs it.
--   `materialized_watermark` written only by the code that (re)derives `agenda_session_schedules`,
--                            and only when it can prove the first column has not moved underneath
--                            it.
--
-- They are equal exactly when the derived table reflects every publication ever written for the
-- event. Detection is therefore one indexed row rather than a replay, which is what makes it
-- affordable on the read path and on the one-minute tick; the replay is reserved for the repair.
--
-- **Why a trigger rather than a constraint.** "An insert into `agenda_publications` must also
-- maintain `agenda_session_schedules`" is not expressible as a constraint: the derived rows are a
-- fold over the whole history that SQL cannot compute in a `CHECK`, and a trigger cannot see
-- statements that come later in the same transaction. So an unmaintained insert cannot be made
-- impossible. It can be made impossible to go *unnoticed*, which is what this does — and it holds
-- for the old Worker in the deploy window, because the trigger belongs to the database the
-- migration has already reached, not to the code that is still being uploaded.
--
-- **Why a counter rather than the newest version.** An earlier draft stored `NEW.version`, which
-- reads better and is weaker in a way that matters: two different writes can carry the same
-- version token. A publication inserted out of order — issue #169's "nothing checks that a
-- publication's version is the event's newest", unreachable through `AgendaService.publish` but
-- not through a direct writer — would then leave the watermark unchanged, and the next ordinary
-- publication would fold past it and mark the event caught up. A counter cannot do that: every
-- write moves it, so a fold can only claim the table by naming the exact count it observed, and a
-- write it did not see makes that claim fail. The number means "how many times this event's
-- history has been written", and nothing reads it as a version.

CREATE TABLE agenda_schedule_materializations (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  -- How many writes `agenda_publications` has taken for this event. Advanced by the triggers
  -- below, never by application code.
  publication_watermark INTEGER NOT NULL CHECK (publication_watermark > 0),
  -- The value `publication_watermark` held when `agenda_session_schedules` was last derived.
  -- NULL means never derived, which is what the backfill below leaves behind and what a deleted
  -- publication restores: both are "re-derive before believing this table".
  materialized_watermark INTEGER CHECK (materialized_watermark > 0),
  materialized_at TEXT
);

-- Drift is rare and the sweep runs every minute, so the index carries only the rows that are
-- drifted rather than one entry per event. SQLite admits a column-to-column predicate in a partial
-- index because the expression is deterministic over the row, which turns "find the events needing
-- repair" into a scan of exactly the events needing repair.
CREATE INDEX agenda_schedule_materializations_drifted_idx
  ON agenda_schedule_materializations (event_id)
  WHERE materialized_watermark IS NOT publication_watermark;

-- Every insert, from every writer, whether or not it maintains the derived table.
--
-- `ON CONFLICT DO UPDATE` rather than a plain UPDATE because an event's first publication has no
-- row yet, and the same statement has to serve both. `materialized_watermark` is left alone on the
-- conflict branch and left NULL on the insert branch: this trigger records that the history moved,
-- and only the fold may claim to have caught up with it.
CREATE TRIGGER agenda_publication_insert_advances_watermark
AFTER INSERT ON agenda_publications
BEGIN
  INSERT INTO agenda_schedule_materializations (event_id, publication_watermark)
  VALUES (NEW.event_id, 1)
  ON CONFLICT(event_id) DO UPDATE
    SET publication_watermark = agenda_schedule_materializations.publication_watermark + 1;
END;

-- A deleted publication changes the fold's input as surely as an inserted one.
--
-- Not a path this system takes — publications are immutable and only the seed reset removes them,
-- which removes this table's rows in the same breath — but the invariant is "the derived table
-- reflects the history", and a history that shrank no longer satisfies it.
--
-- It advances the counter as well as clearing the materialized side, and the first half is the
-- one that is easy to leave out. Clearing alone would let a repair that read the watermark
-- *before* the delete still match its claim afterwards, writing rows that include the deleted
-- snapshot and erasing the invalidation in the same statement. Moving the counter makes that
-- claim fail, which is the whole mechanism working as stated rather than working for inserts only.
CREATE TRIGGER agenda_publication_delete_invalidates_watermark
AFTER DELETE ON agenda_publications
BEGIN
  UPDATE agenda_schedule_materializations
  SET publication_watermark = publication_watermark + 1,
      materialized_watermark = NULL,
      materialized_at = NULL
  WHERE event_id = OLD.event_id;
END;

-- Backfill: every event that has ever published, marked as never derived.
--
-- Not marked as current, though `1601` derived the table from the whole history one migration
-- ago and it almost certainly is. A publication can land between `1601` and `1602` — the deploy
-- window is exactly the hazard this pair of migrations exists for, and it is open while they run —
-- and a migration that asserted "already current" would put the first false statement into the
-- very table whose purpose is to be believed. Leaving `materialized_watermark` NULL costs one
-- replay per published event, spread over the first ticks after deploy at twenty events a tick,
-- and buys a table whose every claim was computed rather than assumed.
--
-- `COUNT(*)` because the column counts writes: an event whose history this migration finds `n`
-- publications long has taken `n` of them.
--
-- `ON CONFLICT DO NOTHING` for the same window. The trigger above already exists by the time this
-- statement runs, so a publication committing in between has created the row, and a bare INSERT
-- would fail on the primary key — leaving `migrate:remote` half-applied, with the table and both
-- triggers created and the migration unrecorded, so the re-run fails on `CREATE TABLE … already
-- exists`. The row the trigger made is the better one anyway: it counts that write.
INSERT INTO agenda_schedule_materializations (event_id, publication_watermark)
SELECT event_id, COUNT(*) FROM agenda_publications GROUP BY event_id
ON CONFLICT(event_id) DO NOTHING;
