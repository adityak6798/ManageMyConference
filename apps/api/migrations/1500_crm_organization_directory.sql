-- The organization-wide speaker directory (PRD-CRM-001, issue #97).
--
-- `crm_prospects` stays exactly as it was: one event's outreach record, with its own contacts
-- and activity. Nothing here alters it, so every conversion provenance row written before this
-- migration keeps its meaning and every existing prospect keeps converting by the same path.
-- The directory is a second, organization-scoped noun that links *to* prospects.

CREATE TABLE crm_organization_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  title TEXT,
  notes TEXT,
  source TEXT NOT NULL,
  merged_into_id TEXT REFERENCES crm_organization_contacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT crm_organization_contacts_name_length CHECK (length(name) BETWEEN 1 AND 160),
  CONSTRAINT crm_organization_contacts_source CHECK (source IN ('manual','import','prospect'))
);

-- "A person appears once" is enforced here rather than by a read-time check, which is what makes
-- a re-import converge instead of duplicating. Partial, because a record that lost a merge keeps
-- its row and its address, and two merged-away records may legitimately share one.
CREATE UNIQUE INDEX crm_organization_contacts_email_idx
  ON crm_organization_contacts (organization_id, email)
  WHERE merged_into_id IS NULL;
CREATE INDEX crm_organization_contacts_directory_idx
  ON crm_organization_contacts (organization_id, company, name);

CREATE TABLE crm_contact_tags (
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);
CREATE INDEX crm_contact_tags_tag_idx ON crm_contact_tags (tag, contact_id);

CREATE TABLE crm_contact_fields (
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  field_key TEXT NOT NULL,
  field_value TEXT NOT NULL,
  PRIMARY KEY (contact_id, field_key)
);
CREATE INDEX crm_contact_fields_lookup_idx ON crm_contact_fields (field_key, field_value);

-- What a merged-away record was called and addressed. Kept so searching for the address on an
-- old badge still finds the person, which is the half of "merge preserves history" that a
-- pointer alone does not give.
CREATE TABLE crm_contact_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  merged_from_id TEXT NOT NULL,
  merged_at TEXT NOT NULL
);
CREATE INDEX crm_contact_aliases_contact_idx ON crm_contact_aliases (contact_id);
CREATE INDEX crm_contact_aliases_email_idx ON crm_contact_aliases (email);

-- One row per event this contact has been sourced into. Stage, speaker and conversion time are
-- deliberately absent: they live on the prospect, and duplicating them here would let the
-- directory and the pipeline disagree about whether somebody converted.
CREATE TABLE crm_contact_events (
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  prospect_id TEXT NOT NULL REFERENCES crm_prospects(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, event_id)
);
CREATE UNIQUE INDEX crm_contact_events_prospect_idx ON crm_contact_events (prospect_id);

CREATE TABLE crm_contact_activities (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  is_private INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  CONSTRAINT crm_contact_activities_is_private CHECK (is_private IN (0,1)),
  CONSTRAINT crm_contact_activities_kind CHECK (
    kind IN ('note','email','call','meeting','import','merge','outreach','conversion')
  )
);
CREATE INDEX crm_contact_activities_timeline_idx
  ON crm_contact_activities (contact_id, occurred_at);

-- A saved view stores its filter definition, never a frozen list of contact ids, so reopening it
-- shows who matches today including everybody imported since.
CREATE TABLE crm_contact_segments (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  CONSTRAINT crm_contact_segments_name_length CHECK (length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX crm_contact_segments_name_idx ON crm_contact_segments (organization_id, name);

CREATE TABLE crm_contact_imports (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_count INTEGER NOT NULL,
  updated_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX crm_contact_imports_organization_idx
  ON crm_contact_imports (organization_id, imported_at);
