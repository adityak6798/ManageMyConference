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
-- `channel` gains `event`, which is what makes that fifth value expressible. Every other channel
-- names an outside system this domain calls over HTTP. `event` names none: it carries a domain
-- event another domain committed, through the same durable machinery, so that the announcement
-- of a fact and the fact itself commit or fail together. Issue #22 asked for exactly that, and
-- PR #113 could not deliver it because the four values pinned here admitted no schedule
-- publication and every other channel would have queued a fabricated external effect —
-- an `airtable`-channel row announcing a publication would have written projection state
-- claiming the schedule had been pushed to somebody's Airtable base.
--
-- SQLite cannot widen a CHECK in place, so this is the standard table rebuild. Foreign keys are
-- disabled for it because `communication_attempts` and `outbound_projection_state` both
-- reference this table by name; the name is dropped and immediately recreated, so their
-- REFERENCES clauses resolve to the new table. Column order, types, defaults, the unique
-- constraint and both indexes are otherwise unchanged from `0019` plus `1700`'s two columns.
PRAGMA foreign_keys = OFF;

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

DROP TABLE communication_deliveries;
ALTER TABLE communication_deliveries_next RENAME TO communication_deliveries;

CREATE INDEX communication_deliveries_worker_idx
  ON communication_deliveries(state, next_attempt_at, lease_token);
CREATE INDEX communication_deliveries_event_idx
  ON communication_deliveries(organization_id, event_id, created_at);

PRAGMA foreign_keys = ON;
