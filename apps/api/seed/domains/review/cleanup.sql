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
-- After the assignments and before the rounds, and both halves of that matter. A membership row
-- whose reviewer still holds an assignment in that round is refused by
-- `review_round_member_holds_assignments` (`1312`), and a round with membership rows still
-- pointing at it is refused by their foreign key. Wrong on either side and a reset fails with a
-- bare constraint error naming no table, which is how the ordering above this line was found.
DELETE FROM review_round_members;
DELETE FROM review_rounds;
DELETE FROM review_plans;
