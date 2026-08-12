-- @spec PRD-REV-001 ARC-003
--
-- Correct the unsafe rebuild recipe recorded in 1300 without changing that deployed migration.
-- D1 executes migration statements with foreign keys enabled, regardless of a preceding
-- `PRAGMA foreign_keys = OFF`. Rebuilding a referenced parent therefore requires copying its
-- children to tables that reference the new parent, dropping the old children first, and only
-- then dropping the old parent. The production database took 1300 while empty and is now seeded;
-- this forward migration deliberately runs over those live rows and leaves the schema unchanged.

DROP TRIGGER review_assignment_cap;
DROP TRIGGER review_completion_rejects_conflict;
DROP TRIGGER review_conflict_rejects_completion;
DROP TRIGGER review_assignment_requires_plan;
DROP TRIGGER review_plan_lock;

CREATE TABLE review_assignments_next (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0),
  created_at TEXT NOT NULL,
  UNIQUE(event_id, proposal_id, reviewer_id, round)
);
INSERT INTO review_assignments_next (id, event_id, proposal_id, reviewer_id, round, created_at)
SELECT id, event_id, proposal_id, reviewer_id, round, created_at FROM review_assignments;

CREATE TABLE review_conflicts_next (
  assignment_id TEXT NOT NULL REFERENCES review_assignments_next(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  PRIMARY KEY(assignment_id, reviewer_id)
);
INSERT INTO review_conflicts_next (assignment_id, reviewer_id, reason, declared_at)
SELECT assignment_id, reviewer_id, reason, declared_at FROM review_conflicts;

CREATE TABLE review_evaluations_next (
  assignment_id TEXT NOT NULL REFERENCES review_assignments_next(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  scores_json TEXT NOT NULL,
  notes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'completed')),
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(assignment_id, reviewer_id)
);
INSERT INTO review_evaluations_next
  (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at)
SELECT assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at
FROM review_evaluations;

DROP TABLE review_conflicts;
DROP TABLE review_evaluations;
DROP TABLE review_assignments;

ALTER TABLE review_assignments_next RENAME TO review_assignments;
ALTER TABLE review_conflicts_next RENAME TO review_conflicts;
ALTER TABLE review_evaluations_next RENAME TO review_evaluations;

CREATE INDEX review_assignments_reviewer_idx ON review_assignments(event_id, reviewer_id);

CREATE TABLE review_outcomes_next (
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0),
  completed_evaluation_count INTEGER NOT NULL,
  average_score REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, proposal_id, round)
);
INSERT INTO review_outcomes_next
  (event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at)
SELECT event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at
FROM review_outcomes;
DROP TABLE review_outcomes;
ALTER TABLE review_outcomes_next RENAME TO review_outcomes;

CREATE TRIGGER review_assignment_cap
BEFORE INSERT ON review_assignments
WHEN EXISTS (
  SELECT 1 FROM review_assignment_caps cap
  WHERE cap.event_id = NEW.event_id AND cap.reviewer_id = NEW.reviewer_id
    AND cap.round = NEW.round
    AND (SELECT COUNT(*) FROM review_assignments assignment
      WHERE assignment.event_id = NEW.event_id
        AND assignment.reviewer_id = NEW.reviewer_id
        AND assignment.round = NEW.round) >= cap.assignment_cap
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ASSIGNMENT_CAP'); END;

CREATE TRIGGER review_completion_rejects_conflict
BEFORE INSERT ON review_evaluations
WHEN NEW.state = 'completed' AND EXISTS (
  SELECT 1 FROM review_conflicts
  WHERE assignment_id = NEW.assignment_id AND reviewer_id = NEW.reviewer_id
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_CONFLICT'); END;

CREATE TRIGGER review_conflict_rejects_completion
BEFORE INSERT ON review_conflicts
WHEN EXISTS (
  SELECT 1 FROM review_evaluations
  WHERE assignment_id = NEW.assignment_id AND reviewer_id = NEW.reviewer_id AND state = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_COMPLETED'); END;

CREATE TRIGGER review_assignment_requires_plan
BEFORE INSERT ON review_assignments
WHEN NOT EXISTS (SELECT 1 FROM review_plans WHERE event_id = NEW.event_id)
BEGIN SELECT RAISE(ABORT, 'REVIEW_PLAN_REQUIRED'); END;

CREATE TRIGGER review_plan_lock
BEFORE UPDATE OF criteria_json ON review_plans
WHEN OLD.criteria_json != NEW.criteria_json
  AND EXISTS (SELECT 1 FROM review_assignments WHERE event_id = OLD.event_id)
BEGIN SELECT RAISE(ABORT, 'REVIEW_PLAN_LOCKED'); END;
