DELETE FROM review_events
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM review_decisions
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM review_outcomes
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
-- `review_suggestions` sits between two foreign keys and has to be deleted between them:
-- `review_evaluations.suggestion_id` points *at* it, so evaluations go first, and
-- `review_suggestions.assignment_id` points at `review_assignments`, so it goes before those.
-- Left out of this list entirely, a reset after any run that drafted a suggestion fails with a
-- bare `FOREIGN KEY constraint failed` from `wrangler d1` that names no table — which is how the
-- ordering was found.
--
-- Evaluations and conflicts carry no event of their own, so they are scoped through the
-- assignments they belong to — the same rows the statement four lines below deletes.
DELETE FROM review_evaluations
WHERE assignment_id IN (
  SELECT id FROM review_assignments
  WHERE event_id IN (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099'
  )
);
DELETE FROM review_suggestions
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM review_conflicts
WHERE assignment_id IN (
  SELECT id FROM review_assignments
  WHERE event_id IN (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099'
  )
);
DELETE FROM review_assignments
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM review_plans
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
