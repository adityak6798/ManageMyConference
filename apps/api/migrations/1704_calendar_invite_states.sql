-- The last iTIP REQUEST actually enqueued for each session/speaker pair.
--
-- A schedule-derived delivery key answered only whether a time had ever been sent. It could not
-- answer whether that time was what the recipient's calendar currently held, so A -> B -> A was
-- suppressed as a duplicate of the first A. This row advances in the same D1 batch as its
-- delivery and supplies the strictly increasing SEQUENCE calendar clients require.
-- @spec PRD-SPK-002 PRD-COM-001 PORT-CALENDAR

CREATE TABLE calendar_invite_states (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  session_id TEXT NOT NULL,
  speaker_profile_id TEXT NOT NULL,
  schedule_ref TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES communication_deliveries(id),
  PRIMARY KEY (organization_id, event_id, session_id, speaker_profile_id)
);

-- PR #137 has already emitted invitations. Preserve the largest client-visible SEQUENCE and the
-- last schedule/address it sent, or the first post-upgrade REQUEST would restart at 0 and clients
-- holding the same UID would ignore it. The old key is
-- `calendar-invite:<session>:<profile>:<starts>|<ends>|<location>`; ids cannot contain `:`.
WITH legacy AS (
  SELECT
    d.*,
    substr(d.idempotency_key, length('calendar-invite:') + 1) AS key_tail,
    json_extract(d.payload_json, '$.calendarInvite.content') AS ics
  FROM communication_deliveries d
  WHERE d.trigger_type = 'speaker.calendar_invite'
    AND d.idempotency_key LIKE 'calendar-invite:%'
), parsed AS (
  SELECT
    legacy.*,
    substr(key_tail, 1, instr(key_tail, ':') - 1) AS session_id,
    substr(key_tail, instr(key_tail, ':') + 1) AS profile_tail
  FROM legacy
), ranked AS (
  SELECT
    organization_id,
    event_id,
    session_id,
    substr(profile_tail, 1, instr(profile_tail, ':') - 1) AS speaker_profile_id,
    substr(profile_tail, instr(profile_tail, ':') + 1) AS schedule_ref,
    recipient_ref,
    CAST(
      substr(
        ics,
        instr(ics, 'SEQUENCE:') + length('SEQUENCE:'),
        instr(substr(ics, instr(ics, 'SEQUENCE:')), char(13)) - length('SEQUENCE:') - 1
      ) AS INTEGER
    ) AS sequence,
    id AS delivery_id,
    row_number() OVER (
      PARTITION BY organization_id, event_id, session_id,
        substr(profile_tail, 1, instr(profile_tail, ':') - 1)
      ORDER BY created_at DESC, id DESC
    ) AS recency
  FROM parsed
  WHERE instr(key_tail, ':') > 0
    AND instr(profile_tail, ':') > 0
    AND instr(ics, 'SEQUENCE:') > 0
)
INSERT INTO calendar_invite_states (
  organization_id, event_id, session_id, speaker_profile_id, schedule_ref,
  recipient_ref, sequence, delivery_id
)
SELECT
  organization_id, event_id, session_id, speaker_profile_id, schedule_ref,
  recipient_ref, sequence, delivery_id
FROM ranked
WHERE recency = 1;
