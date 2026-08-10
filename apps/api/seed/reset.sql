DELETE FROM speaker_messages;
DELETE FROM speaker_assets;
DELETE FROM speaker_tasks;
DELETE FROM content_sessions;
DELETE FROM speaker_profiles;
DELETE FROM event_roles;
DELETE FROM organization_memberships;
DELETE FROM events;
DELETE FROM users;
DELETE FROM organizations;

INSERT INTO organizations (id, name, created_at) VALUES
  ('00000000-0000-4000-8000-000000000010', 'Greenroom Labs', '2026-08-09T12:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000020', 'Outside Organization', '2026-08-09T12:00:00.000Z');

INSERT INTO users (id, name, persona) VALUES
  ('seed-organizer', 'Olivia Organizer', 'organizer'),
  ('seed-reviewer', 'Ravi Reviewer', 'reviewer'),
  ('seed-speaker', 'Sam Speaker', 'speaker'),
  ('seed-public', 'Pat Attendee', 'public');

INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', 'seed-organizer', 'organizer');

INSERT INTO events (id, organization_id, name, timezone, created_at) VALUES
(
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000010',
  'Greenroom Demo Summit',
  'America/Los_Angeles',
  '2026-08-09T12:00:00.000Z'
),
(
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000010',
  'Greenroom Workshop Day',
  'America/New_York',
  '2026-08-10T12:00:00.000Z'
),
(
  '00000000-0000-4000-8000-000000000099',
  '00000000-0000-4000-8000-000000000020',
  'Private Outside Event',
  'UTC',
  '2026-08-11T12:00:00.000Z'
);

INSERT INTO event_roles (event_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000002', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-reviewer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-speaker', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'seed-public', 'public');

INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','seed-speaker','proposal-person-sam','Sam Speaker','sam@example.test','Builds humane conference tools.','they/them','Greenroom Labs',NULL);
INSERT INTO content_sessions (id,event_id,proposal_id,title,abstract,format,speaker_profile_ids,tags,tracks,publication_state,schedule_starts_at,schedule_ends_at,schedule_location) VALUES
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','accepted-proposal-001','Designing the calm conference','A practical guide to reducing operational noise.','45-minute talk','["10000000-0000-4000-8000-000000000001"]','["operations"]','["Product"]','ready','2026-09-15T17:00:00.000Z','2026-09-15T17:45:00.000Z','Main Stage');
INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at) VALUES
('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Confirm profile details','2026-08-20T23:59:00.000Z','open',NULL),
('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Upload a headshot','2026-08-22T23:59:00.000Z','open',NULL);
INSERT INTO speaker_messages (id,event_id,speaker_profile_id,subject,sent_at) VALUES
('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Welcome to Greenroom Demo Summit','2026-08-10T16:00:00.000Z');
