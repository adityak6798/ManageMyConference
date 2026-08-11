CREATE TRIGGER review_conflict_rejects_completion
BEFORE INSERT ON review_conflicts
WHEN EXISTS (
  SELECT 1 FROM review_evaluations
  WHERE assignment_id = NEW.assignment_id
    AND reviewer_id = NEW.reviewer_id
    AND state = 'completed'
)
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_COMPLETED');
END;
