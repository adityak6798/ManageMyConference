DELETE FROM review_events
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_decision_history
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_decisions
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_outcomes
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
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
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  )
);
DELETE FROM review_suggestions
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_conflicts
WHERE assignment_id IN (
  SELECT id FROM review_assignments
  WHERE event_id IN (
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  )
);
DELETE FROM review_assignments
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
-- Before the rounds, because `review_round_members` carries a composite foreign key to
-- `review_rounds(event_id, sequence)` and a round with membership rows still pointing at it
-- cannot be dropped. There is deliberately no trigger requiring assignments to be removed first;
-- the pool-removal rule lives in `setRoundMembers`, while raw seed SQL does not go through it.
DELETE FROM review_round_members
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_rounds
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM review_plans
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
-- `review_assignment_caps` holds no seeded row today, and nothing in the demo writes one — but it
-- carries a foreign key to the event and another to the reviewer's account, so the first cap an
-- organizer sets on a demo event turns the next reset into the same bare
-- `FOREIGN KEY constraint failed` that `review_suggestions` produced above. Scoped now, while the
-- reason is written down, rather than after a reset has failed in front of somebody.
DELETE FROM review_assignment_caps
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
