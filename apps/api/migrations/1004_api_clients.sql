-- Organization-scoped machine credentials. The presented credential is `grn_<prefix>.<secret>`;
-- only the public lookup prefix and SHA-256 digests are stored. Revocation and expiry are read
-- on every request, so both take effect without a cache-invalidation window.
CREATE TABLE api_clients (
  id                       TEXT PRIMARY KEY NOT NULL,
  organization_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  key_prefix               TEXT NOT NULL UNIQUE,
  secret_hash              TEXT NOT NULL,
  previous_secret_hash     TEXT,
  previous_secret_expires_at INTEGER,
  created_by               TEXT NOT NULL REFERENCES users(id),
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER,
  revoked_at               INTEGER,
  CHECK ((previous_secret_hash IS NULL) = (previous_secret_expires_at IS NULL))
);
CREATE INDEX api_clients_key_prefix_idx ON api_clients(key_prefix);
CREATE INDEX api_clients_organization_idx ON api_clients(organization_id, created_at, id);

CREATE TABLE api_client_scopes (
  client_id  TEXT NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'events:read',
    'events:create',
    'events:settings:read',
    'events:settings:update',
    'communications:manage',
    'agenda:manage',
    'crm:manage',
    'content:read',
    'content:manage',
    'review:manage',
    'review:evaluate',
    'identity:manage'
  )),
  PRIMARY KEY (client_id, capability)
);

CREATE TABLE api_client_events (
  client_id TEXT NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, event_id)
);
CREATE INDEX api_client_events_event_idx ON api_client_events(event_id, client_id);

-- `identity_audit_events.action` is a closed CHECK. SQLite cannot widen it in place, so rebuild
-- the table while preserving every existing row and its two query indexes. The new actions carry
-- client identifiers and metadata only; no plaintext secret or digest ever enters `detail`.
ALTER TABLE identity_audit_events RENAME TO identity_audit_events_before_api_clients;

CREATE TABLE identity_audit_events (
  id              TEXT PRIMARY KEY NOT NULL,
  occurred_at     INTEGER NOT NULL,
  action          TEXT NOT NULL CHECK (action IN (
    'session.issued',
    'session.signed_out',
    'session.revoked_all',
    'membership.invited',
    'membership.invitation_revoked',
    'membership.accepted',
    'membership.removed',
    'membership.role_changed',
    'event_role.granted',
    'event_role.revoked',
    'api_client.created',
    'api_client.rotated',
    'api_client.revoked'
  )),
  outcome          TEXT NOT NULL CHECK (outcome IN ('succeeded', 'refused')),
  source           TEXT NOT NULL CHECK (source IN ('human', 'api', 'system')),
  actor_user_id    TEXT,
  subject_user_id  TEXT,
  organization_id  TEXT,
  event_id         TEXT,
  correlation_id   TEXT NOT NULL,
  detail            TEXT
);

INSERT INTO identity_audit_events
  (id, occurred_at, action, outcome, source, actor_user_id, subject_user_id,
   organization_id, event_id, correlation_id, detail)
SELECT id, occurred_at, action, outcome, source, actor_user_id, subject_user_id,
       organization_id, event_id, correlation_id, detail
FROM identity_audit_events_before_api_clients;

DROP TABLE identity_audit_events_before_api_clients;
CREATE INDEX identity_audit_events_org_idx ON identity_audit_events(organization_id, occurred_at);
CREATE INDEX identity_audit_events_actor_idx ON identity_audit_events(actor_user_id, occurred_at);
