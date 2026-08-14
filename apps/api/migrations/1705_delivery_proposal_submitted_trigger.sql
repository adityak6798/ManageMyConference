-- @spec PRD-COM-001 PRD-CFP-002
--
-- Widen `communication_deliveries.trigger_type` by one value: `proposal.submitted`.
--
-- ## Why this is in the communications block from the CFP lane
--
-- `apps/api/migrations/README.md`: "A cross-domain migration uses the block of the domain that
-- owns the table being changed." The table is communications'; the reason to change it is CFP's.
-- Both halves of that are announced in the wave ledger under issue #190 so a concurrent
-- communications lane meets the number rather than the conflict.
--
-- The alternative was reusing an existing trigger for a submission confirmation, and it is worse
-- than it looks: `trigger_type` is what the delivery history, the webhook fan-out and the
-- schedule-mail consumer all read to decide what a row *is*, so labelling a confirmation
-- `speaker.invited` would put a false statement into the one column those readers trust. Decision
-- `D5` deferred this message because the recipient was unverified, not because the vocabulary was
-- full; the account binding in issue #190 answers the recipient question, and this answers the
-- vocabulary one.
--
-- ## Why it rebuilds four tables
--
-- SQLite cannot widen a CHECK in place, and D1 does not honour `PRAGMA foreign_keys` between
-- statements — so the obvious create/copy/drop/rename recipe fails as soon as one child row
-- references the delivery being dropped. Migration `1703` worked that out and this repeats its
-- ordering exactly:
--
--   1. build the new parent and copy into it;
--   2. build new children pointing at the new parent and copy into them;
--   3. drop the old children — nothing references them;
--   4. drop the old parent — its children are gone;
--   5. rename the new parent into place, which rewrites the new children's REFERENCES to it,
--      then rename the children.
--
-- **`1703` had two children and this has three**, which is the one thing a copy of that migration
-- gets wrong. Migration `1704` added `calendar_invite_states`, whose `delivery_id` references this
-- table; a first draft of this file rebuilt only the two `1703` knew about, and step 4 was then
-- false — a single `calendar_invite_states` row is enough to make `DROP TABLE
-- communication_deliveries` fail with `FOREIGN KEY constraint failed`, on exactly the deployments
-- that have ever sent a calendar invitation. The suite could not see it, because
-- `apps/api/seed/reset.sql` leaves that table empty. So the replay in
-- `apps/api/test/d1-migration-rebuild.integration.test.ts` now populates **every** table with a
-- foreign key to the parent before applying this file, and asserts it did — a rebuild's test is
-- worth only as much as the rows it runs against.
--
-- `communication_attempts` and `outbound_projection_state` are restated verbatim from `1703`, which
-- restated them from `0019`; `calendar_invite_states` is restated verbatim from `1704`. None of the
-- three gains or loses anything here; they are rebuilt only because they point at the table that
-- had to be.

CREATE TABLE communication_deliveries_next (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  idempotency_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('speaker.invited', 'reviewer.assigned', 'organizer.digest', 'projection.requested', 'schedule.published', 'speaker.scheduled', 'speaker.task_assigned', 'speaker.task_reminder', 'speaker.calendar_invite', 'decision.recorded', 'proposal.submitted')),
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

-- Restated verbatim from `1704`, including the UNIQUE on `delivery_id` and the composite primary
-- key. This is the child a copy of `1703` forgets, and forgetting it is what makes step 4 below
-- fail on every deployment that has sent one calendar invitation.
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
CREATE INDEX communication_attempts_delivery_idx
  ON communication_attempts(delivery_id, sequence);
