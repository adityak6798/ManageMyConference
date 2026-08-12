

-- Only `seed-<persona>` is resolvable as a demo identity, so a second speaker enriches the
-- programme without adding a second door into the speaker portal.
INSERT INTO users (id, name, persona) VALUES
  ('seed-organizer', 'Olivia Organizer', 'organizer'),
  ('seed-reviewer', 'Ravi Reviewer', 'reviewer'),
  ('seed-speaker', 'Sam Speaker', 'speaker'),
  ('speaker-jordan-bell', 'Jordan Bell', 'speaker'),
  ('seed-public', 'Pat Attendee', 'public');

INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', 'seed-organizer', 'organizer');

INSERT INTO identity_emails (user_id, email) VALUES
  ('seed-organizer', 'organizer@greenroom.test'),
  ('seed-reviewer', 'reviewer@greenroom.test'),
  ('seed-speaker', 'speaker@greenroom.test');
