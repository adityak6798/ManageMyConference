CREATE TRIGGER review_completion_rejects_conflict
BEFORE INSERT ON review_evaluations
WHEN NEW.state = 'completed' AND EXISTS (
  SELECT 1 FROM review_conflicts
  WHERE assignment_id = NEW.assignment_id AND reviewer_id = NEW.reviewer_id
)
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CONFLICT');
END;
