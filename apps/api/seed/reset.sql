DELETE FROM review_events;
DELETE FROM review_outcomes;
DELETE FROM review_evaluations;
DELETE FROM review_conflicts;
DELETE FROM review_assignments;
DELETE FROM review_plans;
DELETE FROM cfp_status_audit;
DELETE FROM cfp_submissions;
DELETE FROM cfp_statuses;
DELETE FROM cfp_forms;
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
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000002', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-reviewer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-speaker', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'seed-public', 'public');

INSERT INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, submitted_at, status) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1, 'seed-hallway', '{"title":"Designing for the hallway track","abstract":"A practical guide to making conference spaces encourage useful, inclusive conversations.","name":"Alex Morgan"}', '2026-08-09T12:01:00.000Z', 'under_review'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1, 'seed-boundaries', '{"title":"Typed boundaries at scale","abstract":"How small explicit contracts keep large TypeScript systems understandable.","name":"Jordan Lee"}', '2026-08-09T12:02:00.000Z', 'submitted'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 1, 'seed-workshop', '{"title":"Workshop proposal","abstract":"A proposal for the secondary event without a configured review plan.","name":"Taylor Kim"}', '2026-08-09T12:03:00.000Z', 'submitted'),
  ('10000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000099', 1, 'seed-private', '{"title":"Private outside proposal","abstract":"This proposal must never cross event boundaries.","name":"Outside Author"}', '2026-08-09T12:04:00.000Z', 'submitted');

INSERT OR REPLACE INTO cfp_statuses (event_id, key, label, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'submitted', 'Submitted', 0),
  ('00000000-0000-4000-8000-000000000001', 'under_review', 'Under review', 1),
  ('00000000-0000-4000-8000-000000000001', 'reviewed', 'Reviewed', 2),
  ('00000000-0000-4000-8000-000000000001', 'withdrawn', 'Withdrawn', 3),
  ('00000000-0000-4000-8000-000000000002', 'submitted', 'Submitted', 0),
  ('00000000-0000-4000-8000-000000000099', 'submitted', 'Submitted', 0);

INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '[{"id":"relevance","name":"Relevance","description":"Fit for this audience","minScore":1,"maxScore":5},{"id":"clarity","name":"Clarity","description":"Strength and clarity of the proposal","minScore":1,"maxScore":5}]', '2026-08-09T12:00:00.000Z');

INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, created_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed-reviewer', '2026-08-09T12:00:00.000Z');
INSERT INTO cfp_forms (event_id, title, description, fields_json, status, version, published_at, published_json)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Share your conference story',
  'Submit a practical session for Greenroom Demo Summit.',
  '[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}]',
  'open',
  1,
  '2026-08-09T12:00:00.000Z',
  '{"eventId":"00000000-0000-4000-8000-000000000001","title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","fields":[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}],"status":"open","version":1,"publishedAt":"2026-08-09T12:00:00.000Z","publishedStatus":"open"}'
);
