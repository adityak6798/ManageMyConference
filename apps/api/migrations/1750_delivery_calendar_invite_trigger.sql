-- @spec PRD-COM-001 PRD-SPK-002 PORT-CALENDAR
--
-- Admit `speaker.calendar_invite` as a delivery trigger, so an organizer can send a speaker the
-- invitation for their own session (#56). SQLite cannot widen a CHECK in place, so the only way to
-- add one value is to rebuild the table.
--
-- WHY THERE IS NO `PRAGMA foreign_keys = OFF` HERE
--
-- The textbook SQLite rebuild recipe turns foreign keys off, drops the old table and renames the
-- new one into place. **D1 does not honour that pragma between statements.** The DROP is therefore
-- checked with foreign keys on, and `communication_attempts` and `outbound_projection_state` both
-- carry a foreign key to `communication_deliveries`, so a single recorded attempt refuses it:
--
--   D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY
--
-- That failure is invisible to the test suite by construction, because `createMigratedDatabase`
-- applies the migrations and *then* the seed: every rebuild in CI copies an empty table and drops
-- one nothing references yet. A deployed database has rows in all three.
-- `apps/api/test/d1-migration-rebuild.integration.test.ts` re-applies this file over the seeded
-- fixture, which is the only arrangement that exercises the copy and the drop with rows present.
--
-- So the children are rebuilt too, and the order is what makes it work with foreign keys enforced
-- throughout: build the new parent, point new children at it, drop the old children, drop the old
-- parent, then rename. Renaming the parent rewrites the new children's REFERENCES for us.
--
-- WHY THIS CONSTRAINT LISTS VALUES NOTHING IN THIS BRANCH WRITES
--
-- Two pull requests widen this constraint in the same wave: #66/#82/#22/#52 add the lifecycle
-- triggers and the `event` channel, and this one adds the calendar invitation. Because a rebuild
-- restates the whole constraint, whichever landed second would silently drop the other's values —
-- a regression that fails no test on either branch in isolation, and that surfaces later as a
-- CHECK failure pointing at the innocent pull request. Both constraints below are the agreed union
-- and are identical in both branches. If the other pull request merges first this file is
-- redundant and should be deleted in the rebase rather than rebuilding the same table twice.
--
-- Nothing else changes: same columns in the same order, same defaults, same unique constraints,
-- same indexes, and every row copied.

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
