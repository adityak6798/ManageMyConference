-- Per-event field locks: what an organizer has closed on this event's own portal (issue #196,
-- and the primitive issue #189's `GAP-028` residual needs).
--
-- **Why this is not the custom-role policy table.** A custom-role policy answers "what may this
-- *staffed role* see", and it only exists where somebody was given a role. This answers "what may
-- the person whose record it is change", which has no role behind it at all: a speaker editing
-- their own profile holds the `speaker` grant everybody gets, and the organizer's decision to
-- freeze the biography after the programme is printed is a property of the *event*.
--
-- The two share their vocabulary deliberately — the same subjects, the same field allowlist, the
-- same View/Lock/Hide, and the same refusal to hide an identifying field — so `fieldAccessFor`
-- composes them without a second rule, and so an organizer reads one table of meanings rather
-- than two. `GAP-028` asks for exactly this: a write surface configured per event instead of
-- fixed in code.
--
-- **Locks never apply to an organizer.** They are resolved onto every *other* grant on the event.
-- An organizer who could lock themselves out of their own board would be the same class of
-- problem the last-administrator guard exists to prevent, and unlike that one it would have no
-- remedy at all.
CREATE TABLE event_field_locks (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL CHECK (subject IN ('session', 'speaker', 'contact')),
  field      TEXT NOT NULL,
  policy     TEXT NOT NULL CHECK (policy IN ('view', 'lock', 'hide')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, subject, field),
  -- The same allowlist `event_custom_role_field_policies` carries, and `GOVERNED_FIELDS` states.
  -- A lock naming a field that does not exist is a lock whose author believes they closed
  -- something.
  CHECK (
    (subject = 'session' AND field IN (
      '*', 'title', 'abstract', 'format', 'tags', 'tracks', 'publicationState')) OR
    (subject = 'speaker' AND field IN (
      '*', 'name', 'email', 'bio', 'pronouns', 'organization', 'photoAssetId',
      'workflowStatus', 'logistics', 'customFields')) OR
    (subject = 'contact' AND field IN (
      '*', 'name', 'email', 'company', 'title', 'notes', 'tags', 'fields', 'activities'))
  ),
  -- And the same identifying-field guard: a record nobody can name is not a redacted record.
  CHECK (NOT (policy = 'hide' AND (
    (subject = 'session' AND field = 'title') OR
    (subject = 'speaker' AND field = 'name') OR
    (subject = 'contact' AND field = 'name'))))
);
CREATE INDEX event_field_locks_event_idx ON event_field_locks(event_id, subject);
