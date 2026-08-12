PRAGMA foreign_keys = OFF;

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
SELECT id, event_id, proposal_id, reviewer_id, 1, created_at FROM review_assignments;
DROP TABLE review_assignments;
ALTER TABLE review_assignments_next RENAME TO review_assignments;
CREATE INDEX review_assignments_reviewer_idx ON review_assignments(event_id, reviewer_id);

CREATE TABLE review_assignment_caps (
  event_id TEXT NOT NULL REFERENCES events(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  round INTEGER NOT NULL CHECK (round > 0),
  assignment_cap INTEGER NOT NULL CHECK (assignment_cap > 0),
  PRIMARY KEY(event_id, reviewer_id, round)
);
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
SELECT event_id, proposal_id, 1, completed_evaluation_count, average_score, updated_at
FROM review_outcomes;
DROP TABLE review_outcomes;
ALTER TABLE review_outcomes_next RENAME TO review_outcomes;

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

PRAGMA foreign_keys = ON;
