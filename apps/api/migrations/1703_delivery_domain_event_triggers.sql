-- @spec PRD-COM-001 PRD-INT-001
--
-- Widen `communication_deliveries`' trigger and channel vocabularies so a lifecycle event can be
-- enqueued and a domain event can be recorded.
--
-- `trigger_type` gains six values. Five of them name the lifecycle moments that now produce a
-- message — a speaker's schedule confirmation, a task being assigned, a task falling due, an
-- accept/decline decision reaching its submitter, and a calendar invitation (issue #66,
-- issue #52, and issue #56's trigger, agreed with the adapter agent so this table is rebuilt
-- once this wave rather than twice). The sixth, `schedule.published`, is not a message at all.
--
-- `decision.recorded` covers both outcomes rather than splitting into accepted and declined:
-- the trigger names what happened in the product, and which of the two templates renders it is
-- already recorded on the delivery's `template_id`.
--
-- `channel` gains `event`, which is what makes that sixth value expressible. Every other channel
-- names an outside system this domain calls over HTTP. `event` names none: it carries a domain
-- event another domain committed, through the same durable machinery, so that the announcement
-- of a fact and the fact itself commit or fail together. Issue #22 asked for exactly that, and
-- PR #113 could not deliver it because the four values pinned in `0019` admitted no schedule
-- publication and every other channel would have queued a fabricated external effect.
--
-- ## Why this rebuilds three tables and not one
--
-- SQLite cannot widen a CHECK in place, so the table has to be recreated. The obvious recipe —
-- `PRAGMA foreign_keys = OFF`, create, copy, drop, rename — **does not work on D1**, and fails in
-- a way no test on an empty table can see: `DROP TABLE communication_deliveries` is refused with
-- `FOREIGN KEY constraint failed` as soon as a single `communication_attempts` row references it.
-- D1 does not honour the pragma across statements, so the drop is checked with foreign keys on.
-- Every deployment that has ever recorded one delivery attempt would have failed this migration;
-- a fresh database would not. Migration `1300` uses that recipe and has the same latent problem,
-- which has never surfaced because nothing had rebuilt a table with live children until now.
--
-- So the children are rebuilt with the parent, in an order where no statement ever violates a
-- foreign key and no row exists in only one place:
--
--   1. build the new parent and copy into it;
--   2. build new children pointing at the new parent and copy into them;
--   3. drop the old children — nothing references them;
--   4. drop the old parent — its children are gone;
--   5. rename the new parent into place, which rewrites the new children's REFERENCES to it,
--      then rename the children.
--
-- `communication_attempts` and `outbound_projection_state` are restated verbatim from `0019`.
-- Neither gains or loses anything here; they are rebuilt only because they point at the table
-- that had to be.

CREATE TABLE communication_deliveries_next (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  idempotency_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('speaker.invited', 'reviewer.assigned', 'organizer.digest', 'projection.requested', 'schedule.published', 'speaker.scheduled', 'speaker.task_assigned', 'speaker.task_reminder', 'speaker.calendar_invite', 'decision.recorded')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'airtable', 'accelevents', 'event')),
  template_id TEXT REFERENCES message_templates(id),
  template_version INTEGER,
  recipient_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  projection_version INTEGER,
  state TEXT NOT NULL CHECK (state IN ('queued', 'retrying', 'succeeded', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rendered_subject TEXT,
  rendered_body TEXT,
  UNIQUE (organization_id, idempotency_key)
);

INSERT INTO communication_deliveries_next (
  id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id,
  template_version, recipient_ref, payload_json, projection_version, state, attempt_count,
  next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body
)
SELECT
  id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id,
  template_version, recipient_ref, payload_json, projection_version, state, attempt_count,
  next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body
FROM communication_deliveries;

CREATE TABLE communication_attempts_next (
  id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES communication_deliveries_next(id),
  sequence INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'retryable_failure', 'terminal_failure')),
  provider_reference TEXT,
  error_code TEXT,
  UNIQUE (delivery_id, sequence)
);

INSERT INTO communication_attempts_next (
  id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code
)
SELECT id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code
FROM communication_attempts;

CREATE TABLE outbound_projection_state_next (
  destination TEXT NOT NULL CHECK (destination IN ('airtable', 'accelevents')),
  event_id TEXT NOT NULL REFERENCES events(id),
  resource_ref TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  delivery_id TEXT NOT NULL REFERENCES communication_deliveries_next(id),
  projected_at TEXT NOT NULL,
  PRIMARY KEY (destination, event_id, resource_ref)
);

INSERT INTO outbound_projection_state_next (
  destination, event_id, resource_ref, version, delivery_id, projected_at
)
SELECT destination, event_id, resource_ref, version, delivery_id, projected_at
FROM outbound_projection_state;

DROP TABLE communication_attempts;
DROP TABLE outbound_projection_state;
DROP TABLE communication_deliveries;

ALTER TABLE communication_deliveries_next RENAME TO communication_deliveries;
ALTER TABLE communication_attempts_next RENAME TO communication_attempts;
ALTER TABLE outbound_projection_state_next RENAME TO outbound_projection_state;

CREATE INDEX communication_deliveries_worker_idx
  ON communication_deliveries(state, next_attempt_at, lease_token);
CREATE INDEX communication_deliveries_event_idx
  ON communication_deliveries(organization_id, event_id, created_at);
CREATE INDEX communication_attempts_delivery_idx
  ON communication_attempts(delivery_id, sequence);
