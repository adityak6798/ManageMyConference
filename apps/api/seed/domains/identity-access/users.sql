

-- Only `seed-<persona>` is resolvable as a demo identity, so a second speaker enriches the
-- programme without adding a second door into the speaker portal.
-- A second reviewer, and the reason it is not a second *persona*.
--
-- Review needs two reviewers to be a demonstrable product: a round's pool means nothing with one
-- person in the directory, one reviewer cannot show that a second cannot read their notes, and a
-- reminder list of one is a button rather than an operation. But `seed-<persona>` is the only
-- shape the demo door resolves, so adding a persona would put a fifth "Continue as…" button on
-- the landing page — an identity-owned product decision, made from a review lane, to solve a
-- review problem. Nina is a seeded *reviewer* instead: she appears in every organizer surface,
-- holds real assignments and completed evaluations, and receives reminders. What she cannot do is
-- sign in through the demo door, which is why the "two reviewers cannot see each other's drafts"
-- evidence is at the service and HTTP tiers rather than in two browser contexts.
INSERT INTO users (id, name, persona) VALUES
  ('seed-organizer', 'Olivia Organizer', 'organizer'),
  ('seed-reviewer', 'Ravi Reviewer', 'reviewer'),
  ('review-nina-alvarez', 'Nina Alvarez', 'reviewer'),
  ('seed-speaker', 'Sam Speaker', 'speaker'),
  ('speaker-jordan-bell', 'Jordan Bell', 'speaker'),
  ('seed-public', 'Pat Attendee', 'public');

INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', 'seed-organizer', 'organizer');

INSERT INTO identity_emails (user_id, email) VALUES
  ('seed-organizer', 'organizer@greenroom.test'),
  ('seed-reviewer', 'reviewer@greenroom.test'),
  -- Linked, so an outstanding-review reminder addressed to her is `queued` rather than
  -- `unaddressable` — which is the state the reminder console has to be able to show.
  ('review-nina-alvarez', 'nina.alvarez@greenroom.test'),
  ('seed-speaker', 'speaker@greenroom.test');
