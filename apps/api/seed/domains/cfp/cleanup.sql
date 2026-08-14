DELETE FROM cfp_status_audit
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
-- Every submission on one of the demo's events goes, seeded or not. A proposal somebody submitted to the
-- demo call *is* demo state — its event is about to be replaced — and no scoping by submitter
-- would be right here: an account-bound proposal from a real person against the demo event still
-- points at a row this reset deletes.
DELETE FROM cfp_submissions
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM cfp_statuses
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM cfp_forms
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
