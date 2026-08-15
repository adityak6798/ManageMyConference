-- One new capability: `reports:pii` (issue #196).
--
-- Reports mask personal data by default. Unmasking is a separate, explicit, audited act, and the
-- thing that authorizes it has to be a capability rather than a role name — otherwise "who may see
-- unmasked contact details in an export" is answered by whoever happens to be an organizer, which
-- is exactly the coupling custom roles exist to break.
--
-- Two closed CHECK lists name every capability in this product, and both are in the identity block:
-- what a machine credential may be scoped to, and what a custom event role may be granted. Neither
-- can be widened in place, so this is a rebuild of both. Every existing row is preserved.
--
-- `reports:pii` IS grantable to a custom role, deliberately. An organization that wants a sponsor
-- liaison who can export addresses should be able to say so; what it must not be is implied. It is
-- absent from every safe template for the same reason.
ALTER TABLE api_client_scopes RENAME TO api_client_scopes_before_reports_pii;

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
    'identity:manage',
    'reports:pii'
  )),
  PRIMARY KEY (client_id, capability)
);

INSERT INTO api_client_scopes (client_id, capability)
SELECT client_id, capability FROM api_client_scopes_before_reports_pii;

DROP TABLE api_client_scopes_before_reports_pii;

ALTER TABLE event_custom_role_capabilities RENAME TO event_custom_role_capabilities_before_pii;

CREATE TABLE event_custom_role_capabilities (
  role_id    TEXT NOT NULL REFERENCES event_custom_roles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'events:read',
    'events:settings:read',
    'communications:manage',
    'agenda:manage',
    'crm:manage',
    'content:read',
    'content:manage',
    'review:manage',
    'review:evaluate',
    'reports:pii'
  )),
  PRIMARY KEY (role_id, capability)
);

INSERT INTO event_custom_role_capabilities (role_id, capability)
SELECT role_id, capability FROM event_custom_role_capabilities_before_pii;

DROP TABLE event_custom_role_capabilities_before_pii;
