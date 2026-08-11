CREATE TRIGGER review_assignment_requires_plan
BEFORE INSERT ON review_assignments
WHEN NOT EXISTS (SELECT 1 FROM review_plans WHERE event_id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_PLAN_REQUIRED');
END;
