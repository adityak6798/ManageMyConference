-- Review-plan invitations and scheduled weekly reminders are distinct delivery facts.
-- Rebuild the communications-owned parent to widen its trigger CHECK, preserving all three
-- children and `1709`'s recipient-trust column.
--
-- @spec PRD-COM-001 PRD-REV-001

CREATE TABLE communication_deliveries_next (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  idempotency_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('speaker.invited', 'reviewer.assigned', 'reviewer.invited', 'reviewer.reminder', 'reviewer.weekly_reminder', 'organizer.digest', 'projection.requested', 'schedule.published', 'speaker.scheduled', 'speaker.task_assigned', 'speaker.task_reminder', 'speaker.calendar_invite', 'decision.recorded', 'proposal.submitted', 'cfp.deadline_approaching', 'cfp.call_closed')),
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
  recipient_trust TEXT NOT NULL DEFAULT 'account' CHECK (recipient_trust IN ('account', 'declared')),
  UNIQUE (organization_id, idempotency_key)
);

INSERT INTO communication_deliveries_next (
  id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id,
  template_version, recipient_ref, payload_json, projection_version, state, attempt_count,
  next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body,
  recipient_trust
)
SELECT
  id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id,
  template_version, recipient_ref, payload_json, projection_version, state, attempt_count,
  next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body,
  recipient_trust
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
INSERT INTO communication_attempts_next
  (id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code)
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
INSERT INTO outbound_projection_state_next
  (destination, event_id, resource_ref, version, delivery_id, projected_at)
SELECT destination, event_id, resource_ref, version, delivery_id, projected_at
FROM outbound_projection_state;

CREATE TABLE calendar_invite_states_next (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  session_id TEXT NOT NULL,
  speaker_profile_id TEXT NOT NULL,
  schedule_ref TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES communication_deliveries_next(id),
  PRIMARY KEY (organization_id, event_id, session_id, speaker_profile_id)
);
INSERT INTO calendar_invite_states_next (
  organization_id, event_id, session_id, speaker_profile_id, schedule_ref,
  recipient_ref, sequence, delivery_id
)
SELECT
  organization_id, event_id, session_id, speaker_profile_id, schedule_ref,
  recipient_ref, sequence, delivery_id
FROM calendar_invite_states;

DROP TABLE communication_attempts;
DROP TABLE outbound_projection_state;
DROP TABLE calendar_invite_states;
DROP TABLE communication_deliveries;

ALTER TABLE communication_deliveries_next RENAME TO communication_deliveries;
ALTER TABLE communication_attempts_next RENAME TO communication_attempts;
ALTER TABLE outbound_projection_state_next RENAME TO outbound_projection_state;
ALTER TABLE calendar_invite_states_next RENAME TO calendar_invite_states;

CREATE INDEX communication_deliveries_worker_idx
  ON communication_deliveries(state, next_attempt_at, lease_token);
CREATE INDEX communication_deliveries_event_idx
  ON communication_deliveries(organization_id, event_id, created_at);
CREATE INDEX communication_deliveries_recipient_cap_idx
  ON communication_deliveries(organization_id, event_id, recipient_trust);
CREATE INDEX communication_attempts_delivery_idx
  ON communication_attempts(delivery_id, sequence);
