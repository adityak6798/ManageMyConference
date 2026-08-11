CREATE TRIGGER review_plan_lock
BEFORE UPDATE OF criteria_json ON review_plans
WHEN OLD.criteria_json != NEW.criteria_json
  AND EXISTS (SELECT 1 FROM review_assignments WHERE event_id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_PLAN_LOCKED');
END;
