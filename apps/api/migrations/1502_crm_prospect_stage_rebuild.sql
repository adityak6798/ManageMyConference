-- @spec PRD-CRM-001 ARC-003
--
-- Drop the stage CHECK by rebuilding `crm_prospects`, so a stage an organizer configured in
-- `1501` is storable at all. Nothing else about the table changes.
--
-- The recipe is `1301`'s, and it is the one D1 actually accepts: foreign keys are enforced
-- between migration statements regardless of `PRAGMA foreign_keys = OFF`, so a referenced parent
-- can only be replaced by copying its children onto the *new* parent, dropping the old children
-- first, and dropping the old parent last. `crm_prospects` has three children — `crm_contacts`,
-- `crm_activities` and `crm_contact_events` — and none of them has children of its own, so the
-- copy stops there.
--
-- This file creates no table of its own and therefore replays cleanly over a populated database,
-- which is what `apps/api/test/d1-migration-rebuild.integration.test.ts` does with it. That is
-- the arrangement #134 asked for and the reason the stage tables live in `1501`.

-- The rebuild. New parent first, then children onto it, then the old children, then the old
-- parent — the only order D1 accepts with foreign keys enforced throughout.
CREATE TABLE crm_prospects_next (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  -- No CHECK: which keys exist is now data, and the application refuses a key this event has
  -- not configured. A constraint here would be the same list in a second place, one deploy out
  -- of date the first time somebody adds a stage.
  stage TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  next_action TEXT,
  next_action_at TEXT,
  speaker_id TEXT REFERENCES speaker_profiles(id),
  converted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO crm_prospects_next (
  id, event_id, name, stage, owner_id, next_action, next_action_at, speaker_id, converted_at,
  created_at, updated_at
)
SELECT
  id, event_id, name, stage, owner_id, next_action, next_action_at, speaker_id, converted_at,
  created_at, updated_at
FROM crm_prospects;

CREATE TABLE crm_contacts_next (
  id TEXT PRIMARY KEY NOT NULL,
  prospect_id TEXT NOT NULL REFERENCES crm_prospects_next(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1))
);
INSERT INTO crm_contacts_next (id, prospect_id, name, email, is_primary)
SELECT id, prospect_id, name, email, is_primary FROM crm_contacts;

CREATE TABLE crm_activities_next (
  id TEXT PRIMARY KEY NOT NULL,
  prospect_id TEXT NOT NULL REFERENCES crm_prospects_next(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK(is_private IN (0,1)),
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO crm_activities_next (id, prospect_id, kind, summary, is_private, occurred_at, actor_id)
SELECT id, prospect_id, kind, summary, is_private, occurred_at, actor_id FROM crm_activities;

CREATE TABLE crm_contact_events_next (
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  prospect_id TEXT NOT NULL REFERENCES crm_prospects_next(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, event_id)
);
INSERT INTO crm_contact_events_next (contact_id, event_id, prospect_id, linked_at)
SELECT contact_id, event_id, prospect_id, linked_at FROM crm_contact_events;

DROP TABLE crm_contact_events;
DROP TABLE crm_activities;
DROP TABLE crm_contacts;
DROP TABLE crm_prospects;

ALTER TABLE crm_prospects_next RENAME TO crm_prospects;
ALTER TABLE crm_contacts_next RENAME TO crm_contacts;
ALTER TABLE crm_activities_next RENAME TO crm_activities;
ALTER TABLE crm_contact_events_next RENAME TO crm_contact_events;

CREATE INDEX crm_prospects_event_pipeline_idx ON crm_prospects(event_id, stage, next_action_at);
CREATE INDEX crm_contacts_prospect_idx ON crm_contacts(prospect_id);
CREATE INDEX crm_activities_timeline_idx ON crm_activities(prospect_id, occurred_at);
CREATE UNIQUE INDEX crm_activities_one_conversion_idx
  ON crm_activities(prospect_id) WHERE kind = 'conversion';
CREATE UNIQUE INDEX crm_contact_events_prospect_idx ON crm_contact_events (prospect_id);
