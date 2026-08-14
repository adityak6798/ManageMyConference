DELETE FROM cfp_status_audit
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
-- Every submission on a seeded event goes, seeded or not. A proposal somebody submitted to the
-- demo call *is* demo state — its event is about to be replaced — and no scoping by submitter
-- would be right here: an account-bound proposal from a real person against the demo event still
-- points at a row this reset deletes.
DELETE FROM cfp_submissions
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM cfp_statuses
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM cfp_forms
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
