-- The templates the product's own lifecycle triggers render from.
--
-- Every placeholder here is a key the enqueueing code actually supplies — an unfilled one refuses
-- the enqueue rather than mailing somebody `Hello {{speakerName}}`, so a template naming a value
-- nobody provides would break the very action it is meant to announce. The pairing of template
-- key to trigger lives in `apps/api/src/index.ts`; these are the messages those bindings name.
--
-- The last row is the covering note an invitation travels with. The invitation itself is not
-- this text: it is the `text/calendar; method=REQUEST` part the email adapter attaches, which is
-- what a mail client turns into an Accept/Decline card. This message is what the speaker reads
-- if their client shows the body, so it names the session and the event rather than repeating
-- the calendar entry.
INSERT INTO message_templates (id, organization_id, template_key, version, channel, subject, body, created_at) VALUES
  ('template-speaker-v1', '00000000-0000-4000-8000-000000000010', 'speaker-invite', 1, 'email', 'Welcome to Greenroom', 'Hello {{speakerName}}, your session is confirmed. Please complete your speaker profile before the event.', '2026-08-10T12:00:00.000Z'),
  ('template-speaker-task-v1', '00000000-0000-4000-8000-000000000010', 'speaker-task', 1, 'email', 'A new task is waiting for you', 'Hello {{speakerName}}, please complete "{{taskTitle}}" by {{dueAt}}. You can do it from your speaker portal.', '2026-08-10T12:00:00.000Z'),
  ('template-speaker-task-reminder-v1', '00000000-0000-4000-8000-000000000010', 'speaker-task-reminder', 1, 'email', 'Reminder: {{taskTitle}}', 'Hello {{speakerName}}, "{{taskTitle}}" is due {{dueAt}} and is still open. You can complete it from your speaker portal.', '2026-08-10T12:00:00.000Z'),
  ('template-schedule-published-v1', '00000000-0000-4000-8000-000000000010', 'schedule-published', 1, 'email', 'The schedule is published', 'Hello {{speakerName}}, the schedule is published and your session has a time. Add it to your calendar: {{calendarUrl}}', '2026-08-10T12:00:00.000Z'),
  ('template-reviewer-assignment-v1', '00000000-0000-4000-8000-000000000010', 'reviewer-assignment', 1, 'email', 'Abstracts are waiting for your review', 'Hello {{reviewerName}}, abstracts have been assigned to you for round {{round}}. Open your review queue when you have time.', '2026-08-10T12:00:00.000Z'),
  ('template-decision-accepted-v1', '00000000-0000-4000-8000-000000000010', 'decision-accepted', 1, 'email', 'Your proposal was accepted', 'Hello {{submitterName}}, we are delighted to tell you that "{{proposalTitle}}" has been accepted. We will be in touch with next steps shortly.', '2026-08-10T12:00:00.000Z'),
  ('template-decision-declined-v1', '00000000-0000-4000-8000-000000000010', 'decision-declined', 1, 'email', 'About your proposal', 'Hello {{submitterName}}, thank you for submitting "{{proposalTitle}}". We had more strong proposals than slots this year and will not be able to programme it. We hope you will submit again.', '2026-08-10T12:00:00.000Z'),
  ('template-calendar-invite-v1', '00000000-0000-4000-8000-000000000010', 'speaker-calendar-invite', 1, 'email', 'Your session at {{eventName}}', 'Hello {{speakerName}}, here is the calendar invitation for {{sessionTitle}} at {{eventName}}. Accept it to add the session to your calendar; if the time changes we will send an update that replaces this entry.', '2026-08-10T12:00:00.000Z');

-- Delivery history for the demo, shaped exactly as the lifecycle triggers now write it.
--
-- Before issue #66 these four rows were invented: `speaker:queued`, `reviewer:retrying`,
-- payload `{"speaker":"Queued Speaker"}` — recipients that matched nothing in the seed, and a
-- state machine tour of rows no action in the product could ever have produced. Each row below
-- is one the product itself would write: the idempotency key has the shape the enqueueing code
-- generates, the recipient is a seeded speaker's real address, and the rendered message is what
-- that template version produces from that payload.
--
-- `speaker.invited` for Sam is the acceptance welcome; the two `speaker.task_assigned` rows are
-- the onboarding tasks content seeds alongside it. The `retrying` row is a genuine fixture
-- outcome — `+timeout` is the sub-address tag `DeterministicProvider` reads — and the terminal
-- row uses `+bounce` the same way, so both states are reachable from the product rather than
-- asserted into the database.
INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at, rendered_subject, rendered_body) VALUES
  ('delivery-speaker-invite', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'speaker-invite:00000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000001', 'speaker.invited', 'email', 'template-speaker-v1', 1, 'sam@example.test', '{"speakerName":"Sam Speaker","sessionTitle":"Designing the calm conference"}', NULL, 'succeeded', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'Welcome to Greenroom', 'Hello Sam Speaker, your session is confirmed. Please complete your speaker profile before the event.'),
  ('delivery-speaker-task-1', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'speaker-task:30000000-0000-4000-8000-000000000001', 'speaker.task_assigned', 'email', 'template-speaker-task-v1', 1, 'sam@example.test', '{"speakerName":"Sam Speaker","taskTitle":"Confirm profile details","dueAt":"2026-08-20T23:59:00.000Z"}', NULL, 'succeeded', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'A new task is waiting for you', 'Hello Sam Speaker, please complete "Confirm profile details" by 2026-08-20T23:59:00.000Z. You can do it from your speaker portal.'),
  ('delivery-speaker-task-2', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'speaker-task:30000000-0000-4000-8000-000000000002', 'speaker.task_assigned', 'email', 'template-speaker-task-v1', 1, 'sam+timeout@example.test', '{"speakerName":"Sam Speaker","taskTitle":"Upload a headshot","dueAt":"2026-08-22T23:59:00.000Z"}', NULL, 'retrying', 1, '2026-08-10T12:05:00.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'A new task is waiting for you', 'Hello Sam Speaker, please complete "Upload a headshot" by 2026-08-22T23:59:00.000Z. You can do it from your speaker portal.'),
  ('delivery-reviewer-assigned', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'reviewer-assigned:00000000-0000-4000-8000-000000000001:seed-reviewer:r1', 'reviewer.assigned', 'email', 'template-reviewer-assignment-v1', 1, 'reviewer+bounce@greenroom.test', '{"reviewerName":"Ravi Reviewer","round":1}', NULL, 'terminal', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'Abstracts are waiting for your review', 'Hello Ravi Reviewer, abstracts have been assigned to you for round 1. Open your review queue when you have time.'),
  ('delivery-schedule-confirmation', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'schedule:00000000-0000-4000-8000-000000000001:v1:seed-speaker', 'speaker.scheduled', 'email', 'template-schedule-published-v1', 1, 'sam@example.test', '{"speakerName":"Sam Speaker","publicationVersion":1,"calendarUrl":"http://127.0.0.1:8788/api/events/00000000-0000-4000-8000-000000000001/speaker-calendar.ics"}', NULL, 'queued', 0, '2026-08-10T12:00:00.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z', 'The schedule is published', 'Hello Sam Speaker, the schedule is published and your session has a time. Add it to your calendar: http://127.0.0.1:8788/api/events/00000000-0000-4000-8000-000000000001/speaker-calendar.ics'),
  ('delivery-session-projection', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'projection:airtable:20000000-0000-4000-8000-000000000001:v1', 'projection.requested', 'airtable', NULL, NULL, 'session:20000000-0000-4000-8000-000000000001', '{"title":"Designing the calm conference"}', 1, 'succeeded', 1, '2026-08-10T12:00:01.000Z', NULL, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', NULL, NULL);

INSERT INTO communication_attempts (id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code) VALUES
  ('attempt-speaker-invite-1', 'delivery-speaker-invite', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'succeeded', 'fake:email:delivery-speaker-invite', NULL),
  ('attempt-speaker-task-1-1', 'delivery-speaker-task-1', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'succeeded', 'fake:email:delivery-speaker-task-1', NULL),
  ('attempt-speaker-task-2-1', 'delivery-speaker-task-2', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'retryable_failure', NULL, 'PROVIDER_TIMEOUT'),
  ('attempt-reviewer-assigned-1', 'delivery-reviewer-assigned', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'terminal_failure', NULL, 'PROVIDER_REJECTED'),
  ('attempt-session-projection-1', 'delivery-session-projection', 1, '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01.000Z', 'succeeded', 'fake:airtable:delivery-session-projection', NULL);

INSERT INTO outbound_projection_state (destination, event_id, resource_ref, version, delivery_id, projected_at)
VALUES ('airtable', '00000000-0000-4000-8000-000000000001', 'session:20000000-0000-4000-8000-000000000001', 1, 'delivery-session-projection', '2026-08-10T12:00:01.000Z');
