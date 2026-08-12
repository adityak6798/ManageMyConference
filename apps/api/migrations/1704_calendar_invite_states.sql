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
