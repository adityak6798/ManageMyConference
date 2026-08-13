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
--   `publication_watermark`  advanced by a trigger on *every* insert into `agenda_publications`,
--                            whoever performs it.
--   `materialized_watermark` written only by the code that (re)derives `agenda_session_schedules`.
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
-- **Why the watermark is a token rather than a claim about the newest version.** It is the version
-- of the most recent publication *write*, which is normally `MAX(version)` and need not remain so:
-- a publication that is deleted leaves the number behind. That is deliberate. Its only job is to
-- differ from `materialized_watermark` whenever the history has moved since the fold last ran, and
-- an equality token does that job without pretending the row it names still exists. The delete
-- trigger below clears `materialized_watermark` for the same reason, rather than trying to recompute
-- a new head.

CREATE TABLE agenda_schedule_materializations (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  -- The version of the most recent write to `agenda_publications` for this event.
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
  VALUES (NEW.event_id, NEW.version)
  ON CONFLICT(event_id) DO UPDATE SET publication_watermark = NEW.version;
END;

-- A deleted publication changes the fold's input as surely as an inserted one.
--
-- Not a path this system takes — publications are immutable and only the seed reset removes them,
-- which removes this table's rows in the same breath — but the invariant is "the derived table
-- reflects the history", and a history that shrank no longer satisfies it. Clearing the
-- materialized side is enough: NULL is unequal to every watermark, so the event is swept, replayed
-- against whatever publications remain, and re-marked.
CREATE TRIGGER agenda_publication_delete_invalidates_watermark
AFTER DELETE ON agenda_publications
BEGIN
  UPDATE agenda_schedule_materializations
  SET materialized_watermark = NULL, materialized_at = NULL
  WHERE event_id = OLD.event_id;
END;

-- Backfill: every event that has ever published, marked as never derived.
--
-- Not marked as current, though `1601` derived the table from the whole history one migration
-- ago and it almost certainly is. Two publications can land between `1601` and `1602` — the
-- deploy window is exactly the hazard this pair of migrations exists for, and it is open while
-- they run — and a migration that asserted "already current" would put the first false statement
-- into the very table whose purpose is to be believed. Leaving `materialized_watermark` NULL costs
-- one replay per published event on the first sweep after deploy and buys a table whose every
-- claim was computed rather than assumed.
INSERT INTO agenda_schedule_materializations (event_id, publication_watermark)
SELECT event_id, MAX(version) FROM agenda_publications GROUP BY event_id;
