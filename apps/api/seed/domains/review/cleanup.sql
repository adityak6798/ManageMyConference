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
-- Before the rounds, because `review_round_members` carries a composite foreign key to
-- `review_rounds(event_id, sequence)` and a round with membership rows still pointing at it
-- cannot be dropped. That is the whole reason, and it is worth saying that it is: an earlier
-- version of this comment also claimed the *assignments* had to go first, refused by a trigger
-- named `review_round_member_holds_assignments`. No such trigger exists — `1312` says in as many
-- words that it deliberately installs none on this table, because the pool-removal rule is a
-- predicate inside `setRoundMembers` and raw seed SQL does not go through it. A comment that
-- names a guard nobody wrote is worse than no comment: the next person edits around a rule that
-- is not there.
DELETE FROM review_round_members;
DELETE FROM review_rounds;
DELETE FROM review_plans;
