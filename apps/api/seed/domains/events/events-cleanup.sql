-- The three events the seed inserts, by id. An event a real conference created — including one
-- created inside a seeded organization — is not the demo's to delete, which is why this scopes on
-- the event ids rather than on their organization.
DELETE FROM events
WHERE id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
