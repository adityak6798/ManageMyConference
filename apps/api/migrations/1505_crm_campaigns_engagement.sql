-- Durable campaign lifecycle, provider engagement facts, and contact-level suppression.
-- @owner crm
-- @spec PRD-CRM-001 PRD-COM-001
CREATE TABLE crm_campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER,
  contact_ids_json TEXT NOT NULL CHECK(json_valid(contact_ids_json)),
  segment_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('draft','scheduled','running','completed','cancelled')),
  scheduled_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX crm_campaigns_organization_state_idx
  ON crm_campaigns(organization_id,state,scheduled_at);
CREATE TABLE crm_engagements (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  campaign_id TEXT REFERENCES crm_campaigns(id),
  contact_id TEXT NOT NULL REFERENCES crm_organization_contacts(id),
  kind TEXT NOT NULL CHECK(kind IN ('delivered','opened','clicked','replied','bounced','unsubscribed')),
  provider_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(organization_id,provider_ref,kind)
);
CREATE INDEX crm_engagements_contact_time_idx ON crm_engagements(contact_id,occurred_at);
CREATE TABLE crm_contact_suppressions (
  contact_id TEXT PRIMARY KEY NOT NULL REFERENCES crm_organization_contacts(id),
  reason TEXT NOT NULL CHECK(reason IN ('bounced','unsubscribed')),
  created_at TEXT NOT NULL
);
