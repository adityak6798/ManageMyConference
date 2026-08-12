

-- The placeholder is {{speakerName}} because that is the one value a send to the event speakers
-- fills in per recipient. A demo template naming anything else would refuse to send, which is
-- correct behaviour and a poor first impression.
INSERT INTO message_templates (id, organization_id, template_key, version, channel, subject, body, created_at) VALUES
  ('template-speaker-v1', '00000000-0000-4000-8000-000000000010', 'speaker-invite', 1, 'email', 'Welcome to Greenroom', 'Hello {{speakerName}}, your session is confirmed. Please complete your speaker profile before the event.', '2026-08-10T12:00:00.000Z');

INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at) VALUES
  ('delivery-queued', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'seed:queued', 'speaker.invited', 'email', 'template-speaker-v1', 1, 'speaker:queued', '{"speaker":"Queued Speaker"}', NULL, 'queued', 0, '2026-08-10T12:00:00.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z'),
  ('delivery-retrying', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'seed:retrying', 'reviewer.assigned', 'email', 'template-speaker-v1', 1, 'reviewer:retrying', '{}', NULL, 'retrying', 1, '2026-08-10T12:05:00.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z'),
  ('delivery-succeeded', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'seed:succeeded', 'projection.requested', 'airtable', NULL, NULL, 'session:success', '{"title":"Opening Keynote"}', 1, 'succeeded', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z'),
  ('delivery-terminal', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'seed:terminal', 'projection.requested', 'accelevents', NULL, NULL, 'session:terminal', '{"title":"Closing Panel"}', 1, 'terminal', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z');

INSERT INTO communication_attempts (id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code) VALUES
  ('attempt-retrying-1', 'delivery-retrying', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'retryable_failure', NULL, 'PROVIDER_TIMEOUT'),
  ('attempt-succeeded-1', 'delivery-succeeded', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'succeeded', 'fake:airtable:delivery-succeeded', NULL),
  ('attempt-terminal-1', 'delivery-terminal', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'terminal_failure', NULL, 'PROVIDER_REJECTED');

INSERT INTO outbound_projection_state (destination, event_id, resource_ref, version, delivery_id, projected_at)
VALUES ('airtable', '00000000-0000-4000-8000-000000000001', 'session:success', 1, 'delivery-succeeded', '2026-08-10T12:00:01.000Z');