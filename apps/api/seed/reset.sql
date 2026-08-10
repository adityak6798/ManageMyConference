DELETE FROM public_event_projections;
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

INSERT INTO public_event_projections (
  event_id, slug, state, draft_json, published_json, published_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'greenroom-demo-summit',
  'published',
  '{"event":{"slug":"greenroom-demo-summit","name":"Greenroom Demo Summit","summary":"A practical gathering for people building thoughtful, inclusive events.","startsOn":"2026-09-17","endsOn":"2026-09-18","timezone":"America/Los_Angeles","venue":"Harbor Conference Center, Oakland"},"cfp":{"title":"Share what you learned","description":"Submit a practical session for organizers, speakers, and community builders.","opensAt":"2026-08-01T16:00:00.000Z","closesAt":"2026-08-28T23:59:00.000Z","submissionUrl":"https://example.com/greenroom-cfp"},"sessions":[{"slug":"calm-systems","title":"Calm systems for busy event teams","abstract":"Design operational systems that make the right next action obvious without hiding important context.","format":"Talk","track":"Operations","speakerSlugs":["maya-chen"],"startsAt":"2026-09-17T17:00:00.000Z","endsAt":"2026-09-17T17:45:00.000Z","room":"Cedar Hall"},{"slug":"accessible-by-default","title":"Accessible by default","abstract":"A hands-on guide to making conference experiences work for more attendees from the first sketch.","format":"Workshop","track":"Experience","speakerSlugs":["jordan-bell"],"startsAt":"2026-09-17T18:15:00.000Z","endsAt":"2026-09-17T19:15:00.000Z","room":"Bay Studio"}],"speakers":[{"slug":"maya-chen","name":"Maya Chen","headline":"Community systems designer","bio":"Maya helps growing communities build humane operational practices."},{"slug":"jordan-bell","name":"Jordan Bell","headline":"Accessibility lead","bio":"Jordan works with event teams to create inclusive digital and physical experiences."}]}',
  '{"event":{"slug":"greenroom-demo-summit","name":"Greenroom Demo Summit","summary":"A practical gathering for people building thoughtful, inclusive events.","startsOn":"2026-09-17","endsOn":"2026-09-18","timezone":"America/Los_Angeles","venue":"Harbor Conference Center, Oakland"},"cfp":{"title":"Share what you learned","description":"Submit a practical session for organizers, speakers, and community builders.","opensAt":"2026-08-01T16:00:00.000Z","closesAt":"2026-08-28T23:59:00.000Z","submissionUrl":"https://example.com/greenroom-cfp"},"sessions":[{"slug":"calm-systems","title":"Calm systems for busy event teams","abstract":"Design operational systems that make the right next action obvious without hiding important context.","format":"Talk","track":"Operations","speakerSlugs":["maya-chen"],"startsAt":"2026-09-17T17:00:00.000Z","endsAt":"2026-09-17T17:45:00.000Z","room":"Cedar Hall"},{"slug":"accessible-by-default","title":"Accessible by default","abstract":"A hands-on guide to making conference experiences work for more attendees from the first sketch.","format":"Workshop","track":"Experience","speakerSlugs":["jordan-bell"],"startsAt":"2026-09-17T18:15:00.000Z","endsAt":"2026-09-17T19:15:00.000Z","room":"Bay Studio"}],"speakers":[{"slug":"maya-chen","name":"Maya Chen","headline":"Community systems designer","bio":"Maya helps growing communities build humane operational practices."},{"slug":"jordan-bell","name":"Jordan Bell","headline":"Accessibility lead","bio":"Jordan works with event teams to create inclusive digital and physical experiences."}]}',
  '2026-08-09T12:00:00.000Z'
);
