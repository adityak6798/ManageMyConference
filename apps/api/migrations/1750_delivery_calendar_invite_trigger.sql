-- @spec PRD-COM-001 PRD-SPK-002 PORT-CALENDAR
--
-- Admit `speaker.calendar_invite` as a delivery trigger, so an organizer can send a speaker the
-- invitation for their own session (#56). SQLite cannot widen a CHECK in place, so the only way
-- to add one value is to rebuild the table.
--
-- WHY THIS CONSTRAINT LISTS VALUES NOTHING IN THIS BRANCH WRITES
--
-- Two pull requests widen this constraint in the same wave: #66/#82/#22/#52 add the four
-- lifecycle triggers and the `event` channel, and this one adds the calendar invitation. Because
-- a rebuild restates the whole constraint, whichever landed second would silently drop the
-- other's values — a regression that fails no test on either branch in isolation, and that
-- surfaces later as a CHECK failure pointing at the innocent pull request.
--
-- So both constraints below are the agreed union of both sets, and are identical in both
-- branches. `schedule.published`, `speaker.scheduled`, `speaker.task_assigned`,
-- `speaker.task_reminder`, `decision.recorded` and the `event` channel have no producer in this
-- branch and are deliberately permitted anyway: an unused value in a CHECK costs nothing, and
-- dropping a value
-- another branch depends on costs a debugging session. If the other pull request merges first,
-- this migration is redundant and should be deleted in the rebase rather than rebuilding the
-- same table twice.
--
-- Nothing else about the table changes: same columns in the same order, same defaults, same
-- unique constraint, same indexes, and every row copied.

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
