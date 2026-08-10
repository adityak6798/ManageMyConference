DELETE FROM crm_activities;
DELETE FROM crm_contacts;
DELETE FROM crm_prospects;
DELETE FROM speaker_conversion_sources;
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

INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Dr. Ada Rivera','contacted','seed-organizer','Follow up on keynote topic','2026-08-08T17:00:00.000Z','2026-08-01T12:00:00.000Z','2026-08-05T12:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Morgan Chen','engaged','seed-organizer','Send formal invitation','2026-08-15T17:00:00.000Z','2026-08-02T12:00:00.000Z','2026-08-06T12:00:00.000Z');
INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Ada Rivera','ada@example.test',1),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Morgan Chen','morgan@example.test',1);
INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','email','Introductory outreach sent',0,'2026-08-05T12:00:00.000Z','seed-organizer'),
  ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','note','Interested in the responsible AI track',1,'2026-08-06T12:00:00.000Z','seed-organizer');
