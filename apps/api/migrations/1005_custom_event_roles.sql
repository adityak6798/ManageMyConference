-- Custom event roles with per-field View/Lock/Hide access (issue #196).
--
-- An organization admin composes a role from a safe template, narrows its capabilities, and
-- writes per-field policies against it. The role is event-scoped because that is where every
-- other grant in this product lives: `requireEventCapability` considers grants on one exact
-- event, and a role that spanned events would be a second authorization model beside it.
--
-- Two things are enforced here rather than only in the service, because they are properties of
-- the data and a service is not the only thing that can write:
--
--   * `identity:manage` is absent from `event_custom_role_capabilities`' CHECK. A custom role
--     that could administer roles could grant itself everything this allowlist withholds, which
--     would make the allowlist decorative. `events:create` and `events:settings:update` are
--     absent for the reasons `field-access.ts` states.
--   * A policy may only name a field the application governs. A role naming a field that does
--     not exist is a role whose author believes they hid something.
CREATE TABLE event_custom_roles (
  id              TEXT PRIMARY KEY NOT NULL,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  template        TEXT NOT NULL CHECK (template IN ('av', 'programme-assistant', 'sponsor-liaison')),
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- Optimistic concurrency. Two admins editing one role's field policies must not silently
  -- interleave into a policy set neither of them chose.
  revision        INTEGER NOT NULL DEFAULT 1,
  CHECK (length(name) BETWEEN 1 AND 80),
  CHECK (length(description) <= 400),
  CHECK (revision >= 1)
);

-- One name per event, case-insensitively: two roles called "AV" and "av" on one board is a
-- misreading waiting to happen, and the screen that lists them cannot tell them apart.
CREATE UNIQUE INDEX event_custom_roles_event_name_idx
  ON event_custom_roles(event_id, lower(name));
CREATE INDEX event_custom_roles_organization_idx
  ON event_custom_roles(organization_id, event_id);

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
    'review:evaluate'
  )),
  PRIMARY KEY (role_id, capability)
);

-- `field = '*'` is the subject-wide default, which is what keeps a policy correct when a column
-- is added later: an AV role stores `contact:*` → hide rather than enumerating today's columns.
CREATE TABLE event_custom_role_field_policies (
  role_id TEXT NOT NULL REFERENCES event_custom_roles(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('session', 'speaker', 'contact')),
  field   TEXT NOT NULL,
  policy  TEXT NOT NULL CHECK (policy IN ('view', 'lock', 'hide')),
  PRIMARY KEY (role_id, subject, field),
  CHECK (
    (subject = 'session' AND field IN (
      '*', 'title', 'abstract', 'format', 'tags', 'tracks', 'publicationState')) OR
    (subject = 'speaker' AND field IN (
      '*', 'name', 'email', 'bio', 'pronouns', 'organization', 'photoAssetId',
      'workflowStatus', 'logistics', 'customFields')) OR
    (subject = 'contact' AND field IN (
      '*', 'name', 'email', 'company', 'title', 'notes', 'tags', 'fields', 'activities'))
  ),
  -- A record with no identifying field is unjoinable and therefore useless to the person the
  -- role was created for: hiding it would produce an export of blank rows rather than a
  -- redacted one. `REQUIRED_FIELDS` in `field-access.ts` is the same list, and `policyFor`
  -- clamps there too so a subject-wide `*` default cannot hide one by the back door.
  CHECK (NOT (policy = 'hide' AND (
    (subject = 'session' AND field = 'title') OR
    (subject = 'speaker' AND field = 'name') OR
    (subject = 'contact' AND field = 'name'))))
);

-- `event_roles.role` is a closed CHECK and the table has no surrogate key, so admitting a custom
-- grant is a rebuild. Every existing row is preserved with a null `custom_role_id`.
--
-- The primary key is unchanged, which states a product rule rather than merely carrying one
-- over: **a person holds at most one custom role on an event.** Two custom roles would make the
-- field decision a negotiation between two policy sets, and every rule for resolving that
-- disagreement is one somebody would have to be told about before they could predict what an
-- exported row contains.
ALTER TABLE event_roles RENAME TO event_roles_before_custom;

CREATE TABLE event_roles (
  event_id       TEXT NOT NULL REFERENCES events(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer', 'speaker', 'public', 'custom')),
  custom_role_id TEXT REFERENCES event_custom_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id, role),
  -- The two halves cannot disagree: a `custom` grant names a role, and no other grant does.
  CHECK ((role = 'custom') = (custom_role_id IS NOT NULL))
);

INSERT INTO event_roles (event_id, user_id, role, custom_role_id)
SELECT event_id, user_id, role, NULL FROM event_roles_before_custom;

DROP TABLE event_roles_before_custom;
CREATE INDEX event_roles_user_id_idx ON event_roles(user_id);
CREATE INDEX event_roles_custom_role_idx ON event_roles(custom_role_id);

-- `identity_audit_events.action` is a closed CHECK, so widening it is a rebuild too. The three
-- new actions carry role identifiers, capability names and field policies in `detail`; no
-- credential enters an audit row, which is the rule `application/identity/audit.ts` states.
ALTER TABLE identity_audit_events RENAME TO identity_audit_events_before_custom_roles;

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
    'api_client.revoked',
    'custom_role.created',
    'custom_role.updated',
    'custom_role.deleted'
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
FROM identity_audit_events_before_custom_roles;

DROP TABLE identity_audit_events_before_custom_roles;
CREATE INDEX identity_audit_events_org_idx ON identity_audit_events(organization_id, occurred_at);
CREATE INDEX identity_audit_events_actor_idx ON identity_audit_events(actor_user_id, occurred_at);
