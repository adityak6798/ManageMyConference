CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL CHECK (persona IN ('organizer', 'reviewer', 'speaker', 'public'))
);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role = 'organizer'),
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE events RENAME TO events_unscoped;
CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO organizations (id, name, created_at)
VALUES (
  '00000000-0000-4000-8000-000000000000',
  'Imported organization',
  '2026-08-09T00:00:00.000Z'
);
INSERT INTO events (id, organization_id, name, timezone, created_at)
SELECT
  id,
  '00000000-0000-4000-8000-000000000000',
  name,
  timezone,
  created_at
FROM events_unscoped;

CREATE TABLE event_roles (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer', 'speaker', 'public')),
  PRIMARY KEY (event_id, user_id, role)
);

INSERT INTO users (id, name, persona)
VALUES ('seed-organizer', 'Olivia Organizer', 'organizer');
INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES (
  '00000000-0000-4000-8000-000000000000',
  'seed-organizer',
  'organizer'
);
INSERT INTO event_roles (event_id, user_id, role)
SELECT id, 'seed-organizer', 'organizer' FROM events_unscoped;
DROP TABLE events_unscoped;

CREATE INDEX events_organization_id_idx ON events(organization_id);
CREATE INDEX event_roles_user_id_idx ON event_roles(user_id);
