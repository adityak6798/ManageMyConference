-- Before `events` and `organizations`, which this references, and for the reason the users
-- fragment gives: D1 does not honour `PRAGMA foreign_keys` between statements, so a cascade
-- cannot be relied on and a row left behind is a live acceptance link pointing at an
-- organization the next reset has already replaced.
DELETE FROM identity_invitations
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM api_client_events
WHERE client_id IN (
  SELECT id FROM api_clients
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
)
  OR event_id IN (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099'
  );
DELETE FROM api_client_scopes
WHERE client_id IN (
  SELECT id FROM api_clients
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM api_clients
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
-- Scoped by event **and** by user, and both halves are load-bearing.
--
-- By event: a role is a row about an event that is being replaced, whoever holds it. A real
-- person granted a role on the demo event loses it — the event they held it on is gone — while
-- their roles on their own conference are untouched.
--
-- By user: every seeded persona is deleted from `users` further down, so every role they hold
-- has to go first, wherever it is. Migration `0002` plants exactly such a row — `seed-organizer`
-- as organizer of every pre-organization event — and the same migration plants the membership
-- below. Leaving either behind makes `DELETE FROM users` fail with a bare `FOREIGN KEY constraint
-- failed`, which is how this pass found them.
DELETE FROM event_roles
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
)
  OR user_id IN (
    'seed-organizer',
    'seed-reviewer',
    'seed-speaker',
    'speaker-jordan-bell',
    'seed-public'
  );
-- Including `00000000-0000-4000-8000-000000000000`'s membership, which migration `0002` plants
-- for `seed-organizer` in the "Imported organization" the seed never re-inserts.
DELETE FROM organization_memberships
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
)
  OR user_id IN (
    'seed-organizer',
    'seed-reviewer',
    'seed-speaker',
    'speaker-jordan-bell',
    'seed-public'
  );
