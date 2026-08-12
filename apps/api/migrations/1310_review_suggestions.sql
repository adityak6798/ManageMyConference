-- Review suggestions: AI drafts, held apart from the reviewer's own record.
--
-- No table rebuild here, deliberately: every statement is a CREATE or an ADD COLUMN, so nothing
-- depends on `PRAGMA foreign_keys` being honoured between statements — the trap `1300` fell into
-- and `1301` repairs. This runs after `1301`, so the ALTER TABLEs below apply to the rebuilt
-- `review_evaluations`.
--
-- **What this adds for the next person who rebuilds a review table.** `review_suggestions` is now
-- a child of `review_assignments`, and `review_evaluations.suggestion_id` makes `review_evaluations`
-- a child of `review_suggestions`. A future rebuild of either parent has to copy and drop those
-- children in the order `1301` demonstrates — the chain is one link longer than it was.
--
-- The separation is the whole point. `review_suggestions` is a sibling of `review_evaluations`,
-- not a column on it: nothing that computes `review_outcomes` joins this table, so no query can
-- accidentally fold a draft score into an aggregate. A suggestion reaches a number an organizer
-- reads only by a reviewer accepting it and then completing their own evaluation.
--
-- @spec PRD-AI-001 PRD-REV-001 PORT-AI

CREATE TABLE review_suggestions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0),
  summary TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered', 'accepted', 'rejected')),
  -- Provenance, four columns rather than a JSON blob, because a stored suggestion whose
  -- provenance cannot be read is not acceptable and a NOT NULL column is how that is enforced
  -- rather than hoped for.
  provenance_model TEXT NOT NULL,
  provenance_prompt_version TEXT NOT NULL,
  provenance_generated_at TEXT NOT NULL,
  provenance_proposal_revision TEXT NOT NULL,
  responded_by TEXT REFERENCES users(id),
  responded_at TEXT,
  created_at TEXT NOT NULL,
  -- A suggestion leaves `offered` only by a named human act. Without this the state column is a
  -- string anything could set, and "never becomes a score without a human action" would rest on
  -- the service alone.
  CHECK (state = 'offered' OR (responded_by IS NOT NULL AND responded_at IS NOT NULL))
);
CREATE INDEX review_suggestions_assignment_idx
  ON review_suggestions(assignment_id, reviewer_id, created_at);

-- How an evaluation came to hold its values.
--
-- ADD COLUMN with a non-null default, so every row that already exists is `manual` — which is
-- true of all of them: they were all written by hand, there being no other way until now.
ALTER TABLE review_evaluations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE review_evaluations ADD COLUMN suggestion_id TEXT REFERENCES review_suggestions(id);

-- The provenance link cannot be fabricated, and it means what it says.
--
-- Three claims, each enforced rather than trusted, because this migration is the only thing
-- standing between "the reviewer accepted this" and "somebody wrote a row saying so":
--
-- 1. `source` is one of exactly two values. A `CHECK` cannot be added by `ALTER TABLE ADD
--    COLUMN`, so it is a trigger — without it an arbitrary string reaches the adapter, which
--    casts it to `EvaluationSource` and hands the transport a shape its own contract forbids.
-- 2. `suggestion_id` is non-null exactly when `source` is `suggested`. A manual evaluation
--    citing a suggestion is a provenance claim nobody made.
-- 3. The cited suggestion is this reviewer's, on this assignment, and has actually been
--    **accepted by them**. Checking only that it exists would let an evaluation cite a
--    suggestion still sitting in `offered` — that is, claim an acceptance that never happened,
--    which is precisely the thing the whole feature promises cannot occur.
--
-- Both triggers fire on every column that carries the claim — `source`, `suggestion_id`,
-- `assignment_id`, `reviewer_id` — because a rule that watches two of four is bypassed by
-- updating one of the other two.
CREATE TRIGGER review_evaluation_source_insert
BEFORE INSERT ON review_evaluations
WHEN NEW.source NOT IN ('manual', 'suggested')
  OR (NEW.source = 'manual' AND NEW.suggestion_id IS NOT NULL)
  OR (NEW.source = 'suggested' AND NOT EXISTS (
    SELECT 1 FROM review_suggestions
    WHERE id = NEW.suggestion_id
      AND assignment_id = NEW.assignment_id
      AND reviewer_id = NEW.reviewer_id
      AND state = 'accepted'
      AND responded_by = NEW.reviewer_id
  ))
BEGIN SELECT RAISE(ABORT, 'REVIEW_SUGGESTION_PROVENANCE'); END;
CREATE TRIGGER review_evaluation_source_update
BEFORE UPDATE OF source, suggestion_id, assignment_id, reviewer_id ON review_evaluations
WHEN NEW.source NOT IN ('manual', 'suggested')
  OR (NEW.source = 'manual' AND NEW.suggestion_id IS NOT NULL)
  OR (NEW.source = 'suggested' AND NOT EXISTS (
    SELECT 1 FROM review_suggestions
    WHERE id = NEW.suggestion_id
      AND assignment_id = NEW.assignment_id
      AND reviewer_id = NEW.reviewer_id
      AND state = 'accepted'
      AND responded_by = NEW.reviewer_id
  ))
BEGIN SELECT RAISE(ABORT, 'REVIEW_SUGGESTION_PROVENANCE'); END;
