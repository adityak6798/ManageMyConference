-- Reusable event templates (issue #102), in the events block 1100-1199.
--
-- `created_by` and `applied_by` hold a user id but declare no foreign key, and that is
-- deliberate rather than an oversight. `defineEventsSchema()` is constructed first in
-- apps/api/src/adapters/persistence/schema/registry.ts because identity-access's own tables
-- reference `events` and `organizations`; a declared reference back to `users` would be a cycle
-- the registry cannot build. A migration-only foreign key would be a constraint the Drizzle
-- declaration does not describe, which `npm run schema:check` refuses — so the column records
-- provenance without pretending to enforce it.
CREATE TABLE event_templates (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 120)
);
-- Archiving is how a template is retired, so an archived name must not keep the name reserved.
CREATE UNIQUE INDEX event_templates_active_name_idx
  ON event_templates (organization_id, name)
  WHERE state = 'active';
CREATE INDEX event_templates_organization_idx ON event_templates (organization_id, state);

CREATE TABLE event_template_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES event_templates(id),
  version INTEGER NOT NULL CHECK (version > 0),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (template_id, version)
);

-- Which template version an event was configured from, so "existing events retain the exact
-- version they were created from" is a stored fact rather than a claim. `applied_at` and
-- `outcome_json` describe the most recent application of that version to that event; the pair
-- (event_id, template_version_id) is what stays fixed, and is the idempotency guard.
CREATE TABLE event_template_applications (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  template_version_id TEXT NOT NULL REFERENCES event_template_versions(id),
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  UNIQUE (event_id, template_version_id)
);
CREATE INDEX event_template_applications_event_idx ON event_template_applications (event_id, applied_at);
