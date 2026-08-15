
-- A scoped operator fixture for PRD-IAM-002's browser and evaluator evidence. Ravi keeps his
-- built-in reviewer grant on the primary event and holds only this custom grant on the second,
-- so the two policy sets never compose into the least-restrictive built-in decision.
INSERT INTO event_custom_roles (
  id, event_id, organization_id, name, description, template, created_by, created_at, updated_at, revision
) VALUES (
  '00000000-0000-4000-8000-000000000196',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000010',
  'Programme operator',
  'Seeded scoped role used to verify wire-level field policy enforcement.',
  'programme-assistant',
  'seed-organizer',
  1786700000000,
  1786700000000,
  1
);
INSERT INTO event_custom_role_capabilities (role_id, capability) VALUES
  ('00000000-0000-4000-8000-000000000196', 'events:read'),
  ('00000000-0000-4000-8000-000000000196', 'content:read'),
  ('00000000-0000-4000-8000-000000000196', 'content:manage');
INSERT INTO event_custom_role_field_policies (role_id, subject, field, policy) VALUES
  ('00000000-0000-4000-8000-000000000196', 'speaker', 'email', 'hide'),
  ('00000000-0000-4000-8000-000000000196', 'speaker', 'bio', 'lock'),
  ('00000000-0000-4000-8000-000000000196', 'session', 'abstract', 'hide');


INSERT INTO event_roles (event_id, user_id, role, custom_role_id) VALUES
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'organizer', NULL),
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'reviewer', NULL),
  ('00000000-0000-4000-8000-000000000002', 'seed-organizer', 'organizer', NULL),
  ('00000000-0000-4000-8000-000000000001', 'seed-reviewer', 'reviewer', NULL),
  ('00000000-0000-4000-8000-000000000002', 'seed-reviewer', 'custom', '00000000-0000-4000-8000-000000000196'),
  ('00000000-0000-4000-8000-000000000001', 'review-nina-alvarez', 'reviewer', NULL),
  ('00000000-0000-4000-8000-000000000001', 'seed-speaker', 'speaker', NULL),
  ('00000000-0000-4000-8000-000000000001', 'speaker-jordan-bell', 'speaker', NULL),
  ('00000000-0000-4000-8000-000000000001', 'seed-public', 'public', NULL);
