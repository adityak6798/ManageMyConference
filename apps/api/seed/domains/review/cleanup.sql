DELETE FROM review_events;
DELETE FROM review_decisions;
DELETE FROM review_outcomes;
-- `review_suggestions` sits between two foreign keys and has to be deleted between them:
-- `review_evaluations.suggestion_id` points *at* it, so evaluations go first, and
-- `review_suggestions.assignment_id` points at `review_assignments`, so it goes before those.
-- Left out of this list entirely, a reset after any run that drafted a suggestion fails with a
-- bare `FOREIGN KEY constraint failed` from `wrangler d1` that names no table — which is how the
-- ordering was found.
DELETE FROM review_evaluations;
DELETE FROM review_suggestions;
DELETE FROM review_conflicts;
DELETE FROM review_assignments;
DELETE FROM review_plans;
