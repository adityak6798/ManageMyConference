-- First-class review rounds: named, date-bounded, lifecycle-stated, with their own scorecard,
-- anonymization policy and reviewer pool.
--
-- @spec PRD-REV-001 PRD-ABS-001 ARC-003
--
-- ## Why nothing is rebuilt here
--
-- The obvious shape for this change is a `review_rounds.id` primary key with a `round_id` foreign
-- key on `review_assignments`, `review_outcomes` and `review_suggestions`. That shape cannot be
-- reached from a deployed database without rebuilding `review_assignments` — and `1300` is the
-- migration in this repository that proves what that costs: D1 executes migration statements with
-- foreign keys enabled whatever `PRAGMA foreign_keys = OFF` says, so rebuilding that one parent
-- means copying and dropping `review_conflicts`, `review_evaluations` and `review_suggestions`
-- first, in that order, and `1310` made the chain one link longer since `1301` last did it.
--
-- Numbered rounds exist in the deployed database, and losing an assignment, an evaluation, a
-- declared conflict, an outcome or a suggestion's provenance to a copy that missed a column is
-- the single worst outcome available to this change. So the round is keyed on the number it
-- already has: `review_rounds(event_id, sequence)`, where `sequence` is exactly the integer
-- `review_assignments.round`, `review_outcomes.round` and `review_suggestions.round` already
-- carry. **No existing table is altered, copied or dropped by this migration.** History is not
-- migrated at all in the sense that risks it; it is *described*, by rows added beside it.
--
-- The cost of that choice is honest and small: a round cannot be renumbered, and a round's
-- identity is a composite key rather than a UUID. Renumbering is not a thing organizers ask for —
-- rounds are ordinal by nature — and the composite key is the key the data already had.
--
-- ## What the backfill claims, and what it does not
--
-- Every `(event_id, round)` that appears anywhere in the existing review history gets a row. The
-- values it gets are the truth about how that round actually behaved, not a guess:
--
--   * `name` is `Round N`, which is what every surface called it.
--   * `state` is `closed` for every round below the event's highest and `open` for the highest,
--     because that is what advancing a round meant: earlier rounds stopped taking work.
--   * `anonymized` is 1, because the reviewer projection has masked the submitter unconditionally
--     since the queue existed. Recording it as 0 would be a claim about past reviews that is false.
--   * `criteria_json` is NULL, meaning "this round scores against the event plan". Snapshotting
--     the current plan into a finished round would be worse, not better: the plan is locked once
--     any assignment exists (`review_plan_lock`), so the event plan *is* the rubric those rounds
--     were judged under, and a copy of it could only drift.
--   * `pool_mode` is `event`, so every reviewer staffed on the event may be assigned in a
--     backfilled round — which is precisely what was true before this migration, and a restriction
--     invented retroactively would refuse assignments that used to succeed.
--
-- `review_round_members` is still backfilled from who actually held an assignment in each round.
-- Under `pool_mode = 'event'` that list restricts nothing; it is the record of who was there, and
-- it is what an organizer sees and edits before switching the round to `named`.
--
-- `opens_at`/`closes_at` are NULL for a backfilled round rather than invented from
-- `created_at`: nobody set a window on those rounds, and a window the product enforces must not be
-- one this migration made up.

CREATE TABLE review_rounds (
  event_id TEXT NOT NULL REFERENCES events(id),
  -- The number the history already carries. `review_assignments.round`,
  -- `review_outcomes.round` and `review_suggestions.round` all join on exactly this.
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  name TEXT NOT NULL,
  -- NULL means unbounded on that side. A round with no window is open whenever its state says so.
  opens_at TEXT,
  closes_at TEXT,
  -- `draft` takes no work yet, `open` takes work, `closed` is view-only and permanent history.
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed')),
  -- Whether reviewers in this round see the author. A correctness property, not a display
  -- preference: the projection, the export, the audit timeline and the AI input all read it.
  anonymized INTEGER NOT NULL DEFAULT 1 CHECK (anonymized IN (0, 1)),
  -- This round's own scorecard. NULL means "score against the event's `review_plans` row", which
  -- is what every round did before this migration and what a round created without an override
  -- keeps doing.
  criteria_json TEXT,
  -- `event`: any reviewer staffed on the event may be assigned in this round.
  -- `named`: only the reviewers listed in `review_round_members` may.
  pool_mode TEXT NOT NULL DEFAULT 'named' CHECK (pool_mode IN ('event', 'named')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, sequence),
  -- Two rounds of one event cannot share a name: the name is what an organizer selects a round
  -- by, and two "Second pass" rounds is a way to assign work to the wrong one.
  UNIQUE (event_id, name),
  -- A window that ends before it starts is not a window. Checked here rather than only in the
  -- service, because a round's dates are what the application boundary refuses work against.
  CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
);

CREATE TABLE review_round_members (
  event_id TEXT NOT NULL,
  round_sequence INTEGER NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (event_id, round_sequence, reviewer_id),
  -- The membership row cannot outlive its round, and cannot name a round that does not exist:
  -- a pool is meaningless without the round whose pool it is.
  FOREIGN KEY (event_id, round_sequence) REFERENCES review_rounds(event_id, sequence)
);
CREATE INDEX review_round_members_reviewer_idx
  ON review_round_members(event_id, reviewer_id);

-- Every round the existing history mentions, from all three tables that carry a round number.
-- `review_outcomes` and `review_suggestions` are included rather than assumed to be covered by
-- `review_assignments`: they are, today, but a backfill that silently depends on that would drop
-- a round the day it stops being true, and a dropped round is a round whose work becomes
-- unreachable.
INSERT INTO review_rounds
  (event_id, sequence, name, opens_at, closes_at, state, anonymized, criteria_json, pool_mode,
   created_at, updated_at)
SELECT
  observed.event_id,
  observed.sequence,
  'Round ' || observed.sequence,
  NULL,
  NULL,
  CASE WHEN observed.sequence = (
    SELECT MAX(peer.sequence) FROM (
      SELECT event_id, round AS sequence FROM review_assignments
      UNION SELECT event_id, round FROM review_outcomes
      UNION SELECT event_id, round FROM review_suggestions
    ) peer WHERE peer.event_id = observed.event_id
  ) THEN 'open' ELSE 'closed' END,
  1,
  NULL,
  'event',
  observed.first_seen,
  observed.first_seen
FROM (
  SELECT event_id, sequence, MIN(created_at) AS first_seen FROM (
    SELECT event_id, round AS sequence, created_at FROM review_assignments
    UNION ALL SELECT event_id, round, updated_at FROM review_outcomes
    UNION ALL SELECT event_id, round, created_at FROM review_suggestions
  ) GROUP BY event_id, sequence
) observed;

-- Who actually reviewed in each round. Under `pool_mode = 'event'` this restricts nothing; it is
-- the pool an organizer opens the console to and the list they promote to `named`.
INSERT INTO review_round_members (event_id, round_sequence, reviewer_id, added_at)
SELECT event_id, round, reviewer_id, MIN(created_at)
FROM review_assignments
GROUP BY event_id, round, reviewer_id;

-- An assignment may not name a round that does not exist.
--
-- Deliberately a trigger rather than a foreign key on `review_assignments`: adding a foreign key
-- to an existing table requires rebuilding it, which is the one thing this migration refuses to
-- do. The rule is the same rule; only its enforcement mechanism differs, and a `BEFORE INSERT`
-- trigger is checked on exactly the statement a foreign key would be.
--
-- The backfill above ran first, so every assignment that already exists has its round.
CREATE TRIGGER review_assignment_requires_round
BEFORE INSERT ON review_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM review_rounds WHERE event_id = NEW.event_id AND sequence = NEW.round
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_REQUIRED'); END;

-- A closed round is history, and history does not gain assignments.
--
-- The service refuses this first and says why; this is the guard for a round closed between that
-- read and this write, and for anything that did not come through the service at all.
CREATE TRIGGER review_assignment_requires_open_round
BEFORE INSERT ON review_assignments
WHEN EXISTS (
  SELECT 1 FROM review_rounds
  WHERE event_id = NEW.event_id AND sequence = NEW.round AND state != 'open'
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_NOT_OPEN'); END;

-- A named pool means what it says.
--
-- Without this the pool is a list the service consults, which is a convention one direct insert
-- breaks. With it, "membership in one round does not implicitly grant membership in another" is
-- a property of the schema: `review_round_members` is keyed on the round, so a reviewer in
-- round 1 is simply not in round 2's rows.
CREATE TRIGGER review_assignment_requires_pool_membership
BEFORE INSERT ON review_assignments
WHEN EXISTS (
  SELECT 1 FROM review_rounds
  WHERE event_id = NEW.event_id AND sequence = NEW.round AND pool_mode = 'named'
) AND NOT EXISTS (
  SELECT 1 FROM review_round_members
  WHERE event_id = NEW.event_id AND round_sequence = NEW.round AND reviewer_id = NEW.reviewer_id
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_POOL'); END;

-- A closed round's scorecard, dates, anonymization and pool are frozen.
--
-- Reopening is allowed — `state` is not in the watched column list — because an organizer who
-- closed a round early has to be able to undo that. What cannot happen is a closed round's
-- *terms* changing under evaluations already made against them: an aggregate computed from one
-- rubric must not be re-explained by another, and a blind round must not become an open one after
-- the fact and retroactively expose authors to reviewers who scored them blind.
CREATE TRIGGER review_round_closed_terms_locked
BEFORE UPDATE OF criteria_json, anonymized, opens_at, closes_at, pool_mode ON review_rounds
WHEN OLD.state = 'closed'
  AND (
    OLD.criteria_json IS NOT NEW.criteria_json
    OR OLD.anonymized != NEW.anonymized
    OR OLD.opens_at IS NOT NEW.opens_at
    OR OLD.closes_at IS NOT NEW.closes_at
    OR OLD.pool_mode != NEW.pool_mode
  )
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_CLOSED'); END;

-- ## Two notes for whoever rebuilds `review_assignments` next
--
-- **The three triggers above go with the table, and nothing puts them back.** SQLite drops a
-- table's triggers when it drops the table, so a create/copy/drop/rename rebuild silently leaves
-- an assignments table with no round guard, no open-round guard and no pool guard — the rules
-- still hold in the service, and stop holding in the schema, which is the half that was the point.
-- `1301` restates the four triggers `1300` had for exactly this reason; a future rebuild has to
-- restate seven. `d1-review-repository.integration.test.ts` asserts the full set by name after a
-- replay, so this fails loudly rather than quietly.
--
-- **There is deliberately no trigger on `review_round_members`.** "A reviewer who already holds
-- work in this round cannot be removed from its pool" is a real rule and it is enforced — but as
-- a `NOT EXISTS` predicate on the DELETE itself, in `D1ReviewRepository.setRoundMembers`, rather
-- than as a `BEFORE DELETE` trigger here. A trigger whose body reads `review_assignments` is
-- evaluated whenever that table is mid-rebuild, so it turns every future rebuild of a table it
-- does not even belong to into a failure that names a third table. The guarded DELETE is just as
-- unbypassable — the statement cannot remove the row, whatever the caller believes — and it is
-- the same "guarded rather than checked-then-run" shape `deleteAssignment` already uses two files
-- away.
