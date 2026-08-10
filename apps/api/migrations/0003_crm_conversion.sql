CREATE TABLE crm_prospects (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  stage TEXT NOT NULL CHECK(stage IN ('identified','contacted','engaged','invited','converted')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  next_action TEXT,
  next_action_at TEXT,
  speaker_id TEXT,
  converted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX crm_prospects_event_pipeline_idx ON crm_prospects(event_id, stage, next_action_at);
CREATE TABLE crm_contacts (id TEXT PRIMARY KEY NOT NULL, prospect_id TEXT NOT NULL REFERENCES crm_prospects(id), name TEXT NOT NULL, email TEXT NOT NULL, is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)));
CREATE INDEX crm_contacts_prospect_idx ON crm_contacts(prospect_id);
CREATE TABLE crm_activities (id TEXT PRIMARY KEY NOT NULL, prospect_id TEXT NOT NULL REFERENCES crm_prospects(id), kind TEXT NOT NULL, summary TEXT NOT NULL, is_private INTEGER NOT NULL CHECK(is_private IN (0,1)), occurred_at TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id));
CREATE INDEX crm_activities_timeline_idx ON crm_activities(prospect_id, occurred_at);
CREATE UNIQUE INDEX crm_activities_one_conversion_idx ON crm_activities(prospect_id) WHERE kind = 'conversion';
