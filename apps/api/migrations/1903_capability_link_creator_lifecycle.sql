-- A capability link created by a disposable demo persona must not make the next deterministic
-- reset impossible. The link is authority delegated by its creator; when that identity is
-- removed, withdrawing the delegation is the safe and useful lifecycle. `resource_ref` remains
-- deliberately without a foreign key because platform does not own the referenced resource.
--
-- This belongs in storage rather than the seed cleanup: historical migration tests apply the
-- current seed before `capability_links` exists, while a cascade is valid at every migration
-- boundary and also protects ordinary account deletion outside the demo fixture.
ALTER TABLE capability_links RENAME TO capability_links_before_creator_lifecycle;

CREATE TABLE capability_links (
  id              TEXT PRIMARY KEY NOT NULL,
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('report', 'speaker-profile', 'speaker-asset')),
  resource_ref    TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  password_hash   TEXT CHECK (password_hash IS NULL OR length(password_hash) = 64),
  created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  view_limit      INTEGER CHECK (view_limit IS NULL OR view_limit >= 1),
  views           INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  revoked_at      TEXT,
  scope_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json))
);

INSERT INTO capability_links (
  id, resource_kind, resource_ref, organization_id, event_id, token_hash, password_hash,
  created_by, created_at, expires_at, view_limit, views, revoked_at, scope_json
)
SELECT
  id, resource_kind, resource_ref, organization_id, event_id, token_hash, password_hash,
  created_by, created_at, expires_at, view_limit, views, revoked_at, scope_json
FROM capability_links_before_creator_lifecycle;

DROP TABLE capability_links_before_creator_lifecycle;
CREATE INDEX capability_links_resource_idx
  ON capability_links(resource_kind, resource_ref, created_at);
CREATE INDEX capability_links_expiry_idx
  ON capability_links(expires_at) WHERE revoked_at IS NULL;
