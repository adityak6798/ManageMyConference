-- Itineraries first: they reference events(id), so leaving them behind makes the events
-- cleanup below fail with a foreign key violation rather than with anything that names
-- this table. A reset is also the right moment to drop them — they are attendee state
-- against a demo snapshot, and no seeded itinerary exists to restore.
DELETE FROM attendee_itineraries;
DELETE FROM public_event_projections;
-- Last-sync state is product-written, not seeded, so nothing here recreates it — but it holds a
-- foreign key to `events`, and the reset deletes events. Without this line one applied Accelevents
-- sync makes every later `npm run reset` fail with FOREIGN KEY constraint failed, and the demo the
-- reset exists to restore stays broken until someone deletes the row by hand.
DELETE FROM accelevents_sync_runs;
DELETE FROM calendar_invite_states;
DELETE FROM outbound_projection_state;
DELETE FROM communication_attempts;
DELETE FROM communication_deliveries;
DELETE FROM message_templates;

DELETE FROM agenda_publications;
DELETE FROM agenda_drafts;
DELETE FROM crm_contact_activities;
DELETE FROM crm_contact_aliases;
DELETE FROM crm_contact_events;
DELETE FROM crm_contact_fields;
DELETE FROM crm_contact_tags;
DELETE FROM crm_contact_segments;
DELETE FROM crm_contact_imports;
DELETE FROM crm_organization_contacts;
DELETE FROM crm_activities;
DELETE FROM crm_contacts;
DELETE FROM crm_prospects;

DELETE FROM speaker_resources;
DELETE FROM content_asset_comments;
DELETE FROM content_revisions;
DELETE FROM content_speaker_import_rows;
DELETE FROM speaker_conversion_sources;
DELETE FROM speaker_conversion_claims;
DELETE FROM speaker_email_claims;
DELETE FROM speaker_messages;
DELETE FROM speaker_assets;
DELETE FROM speaker_tasks;
DELETE FROM content_sessions;
DELETE FROM speaker_profiles;
DELETE FROM review_events;
DELETE FROM review_decisions;
DELETE FROM review_outcomes;
-- `review_suggestions` sits between two foreign keys and has to be deleted between them:
-- `review_evaluations.suggestion_id` points *at* it, so evaluations go first, and
-- `review_suggestions.assignment_id` points at `review_assignments`, so it goes before those.
-- Left out of this list entirely, a reset after any run that drafted a suggestion fails with a
-- bare `FOREIGN KEY constraint failed` from `wrangler d1` that names no table — which is how the
-- ordering was found.
DELETE FROM review_evaluations;
DELETE FROM review_suggestions;
DELETE FROM review_conflicts;
DELETE FROM review_assignments;
DELETE FROM review_plans;

DELETE FROM cfp_status_audit;
DELETE FROM cfp_submissions;
DELETE FROM cfp_statuses;
DELETE FROM cfp_forms;
DELETE FROM event_roles;
DELETE FROM organization_memberships;

-- Applications reference versions, versions reference templates and events, so they go first.
DELETE FROM event_template_applications;
DELETE FROM event_template_versions;
DELETE FROM event_templates;

DELETE FROM events;
DELETE FROM identity_login_challenges;
-- In-flight sign-in attempts hold no foreign key, but a reset that leaves them behind leaves a
-- callback able to complete against a database whose users have just been replaced.
DELETE FROM identity_oauth_attempts;
-- Before `users`: this references it, and D1 does not honour `PRAGMA foreign_keys` between
-- statements, so relying on the cascade would leave rows that make the next reset fail.
DELETE FROM identity_provider_accounts;
DELETE FROM identity_emails;
DELETE FROM users;

DELETE FROM organizations;

INSERT INTO organizations (id, name, created_at) VALUES
  ('00000000-0000-4000-8000-000000000010', 'Greenroom Labs', '2026-08-09T12:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000020', 'Outside Organization', '2026-08-09T12:00:00.000Z');

-- Only `seed-<persona>` is resolvable as a demo identity, so a second speaker enriches the
-- programme without adding a second door into the speaker portal.
INSERT INTO users (id, name, persona) VALUES
  ('seed-organizer', 'Olivia Organizer', 'organizer'),
  ('seed-reviewer', 'Ravi Reviewer', 'reviewer'),
  ('seed-speaker', 'Sam Speaker', 'speaker'),
  ('speaker-jordan-bell', 'Jordan Bell', 'speaker'),
  ('seed-public', 'Pat Attendee', 'public');

INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', 'seed-organizer', 'organizer');

INSERT INTO identity_emails (user_id, email) VALUES
  ('seed-organizer', 'organizer@greenroom.test'),
  ('seed-reviewer', 'reviewer@greenroom.test'),
  ('seed-speaker', 'speaker@greenroom.test');


INSERT INTO events (id, organization_id, name, timezone, created_at) VALUES
(
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000010',
  'Greenroom Demo Summit',
  'America/Los_Angeles',
  '2026-08-09T12:00:00.000Z'
),
(
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000010',
  'Greenroom Workshop Day',
  'America/New_York',
  '2026-08-10T12:00:00.000Z'
),
(
  '00000000-0000-4000-8000-000000000099',
  '00000000-0000-4000-8000-000000000020',
  'Private Outside Event',
  'UTC',
  '2026-08-11T12:00:00.000Z'
);

-- One reusable template captured from Greenroom Demo Summit, so the demo has something to
-- preview and apply without an organizer having to save one first. The payload is exactly what
-- `cfpTemplateSlice.export` produces from the seeded CFP form: title, description, fields and
-- routing, and nothing else. No published snapshot, no submissions, no people.
INSERT INTO event_templates (id, organization_id, name, state, created_at, updated_at) VALUES (
  '00000000-0000-4000-8000-000000000110',
  '00000000-0000-4000-8000-000000000010',
  'Annual summit starter',
  'active',
  '2026-08-11T09:00:00.000Z',
  '2026-08-11T09:00:00.000Z'
);

INSERT INTO event_template_versions (
  id, template_id, version, source_event_id, payload_json, created_at, created_by
) VALUES (
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000110',
  1,
  '00000000-0000-4000-8000-000000000001',
  '{"capturedAt":"2026-08-11T09:00:00.000Z","source":{"eventId":"00000000-0000-4000-8000-000000000001","eventName":"Greenroom Demo Summit","timezone":"America/Los_Angeles"},"slices":{"cfp":{"title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","fields":[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"name","type":"short_text","label":"Your name","guidance":"How organizers should address you","required":false,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}],"routing":[]}}}',
  '2026-08-11T09:00:00.000Z',
  'seed-organizer'
);


INSERT INTO event_roles (event_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000002', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-reviewer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-speaker', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'speaker-jordan-bell', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'seed-public', 'public');-- The templates the product's own lifecycle triggers render from.
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

INSERT INTO agenda_drafts (event_id, draft_json, updated_at) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"},{"id":"track-practice","name":"Practice","color":"#16866b"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"},{"id":"slot-1000","startsAt":"2026-09-01T17:00:00.000Z","endsAt":"2026-09-01T18:00:00.000Z"}],"sessions":[],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}',
  '2026-08-10T20:00:00.000Z'
);
INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, '2026-08-10T20:00:00.000Z', 'seed-organizer',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"}],"sessions":[{"id":"20000000-0000-4000-8000-000000000001","title":"Designing the calm conference","speakerIds":["10000000-0000-4000-8000-000000000001"]}],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}'
);
-- Jordan carries the seeded headshot so the public gallery demonstrates both avatar
-- paths — a real portrait and a monogram — and so Sam's open "Upload a headshot" task
-- still describes work that is genuinely outstanding. Neither profile names a photo here:
-- the pairing is made below, from the uploads, the way the product makes it.
INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','seed-speaker','proposal-person-sam','Sam Speaker','sam@example.test','Builds humane conference tools.','they/them','Greenroom Labs',NULL),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','speaker-jordan-bell','proposal-person-jordan','Jordan Bell','jordan.bell@example.test','Jordan works with event teams to create inclusive digital and physical experiences.','she/her','Northwind Access',NULL);
-- `npm run reset` also writes these bytes into the local R2 bucket under `storage_key`,
-- so an anonymous GET /api/speaker-assets/<id> serves a real image from a clean seed.
INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at) VALUES
('90000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','jordan-bell-portrait.png','image/png','00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/90000000-0000-4000-8000-000000000001','publishable','2026-08-10T17:00:00.000Z');
-- The demo headshot is resolved rather than asserted: the profile takes its own most recent
-- *image* upload, which is exactly what PUT /api/speaker-profiles/{profileId}/photo accepts —
-- the asset must belong to this profile, and it must be an image. A seed is applied by
-- wrangler d1 execute before any Worker exists, so it cannot issue that request itself, and
-- deriving the value is how it stops asserting the pairing by hand. If the upload were ever
-- removed, or replaced with a PDF, this leaves the column NULL and the gallery draws a
-- monogram, instead of leaving a dangling id that publishes a URL which 404s.
-- Keep seed comments free of semicolons and apostrophes: several suites split this file on
-- statement terminators and would read either as one.
UPDATE speaker_profiles
   SET photo_asset_id = (
     SELECT speaker_assets.id
       FROM speaker_assets
      WHERE speaker_assets.speaker_profile_id = speaker_profiles.id
        AND speaker_assets.content_type LIKE 'image/%'
      ORDER BY speaker_assets.uploaded_at DESC, speaker_assets.id DESC
      LIMIT 1)
 WHERE id = '10000000-0000-4000-8000-000000000002';
-- No session carries a time of its own. The opening talk is scheduled because the agenda
-- publication above places it in Main stage at 09:00, and that placement is the only answer
-- the portal, the .ics export, and the public schedule read.
INSERT INTO content_sessions (id,event_id,proposal_id,title,abstract,format,speaker_profile_ids,tags,tracks,publication_state) VALUES
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000010','Designing the calm conference','A practical guide to reducing operational noise.','45-minute talk','["10000000-0000-4000-8000-000000000001"]','["operations"]','["Platform"]','published'),
('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011','Accessible by default','A hands-on guide to making conference experiences work for more attendees from the first sketch.','60-minute workshop','["10000000-0000-4000-8000-000000000002"]','["accessibility"]','["Experience"]','published');
INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at) VALUES
('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Confirm profile details','2026-08-20T23:59:00.000Z','open',NULL),
('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Upload a headshot','2026-08-22T23:59:00.000Z','open',NULL);
INSERT INTO speaker_messages (id,event_id,speaker_profile_id,subject,sent_at) VALUES
('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Welcome to Greenroom Demo Summit','2026-08-10T16:00:00.000Z');
INSERT INTO speaker_resources (id,event_id,title,slug,body_html,embed_html,visibility,sort_order) VALUES
('41000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Speaker handbook','speaker-handbook','<h2>Welcome to Greenroom</h2><p>Use this portal to finish your tasks and share deliverables.</p>','','visible',0);

-- Every submission stores the snapshot of the form it was filled in against, so the organizer
-- projection derives the submitter from real field types rather than a heuristic, and every one
-- answers the required contact-email field the published form asks for.
INSERT INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, submitted_at, status) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1, 'seed-hallway', '{"title":"Designing for the hallway track","abstract":"A practical guide to making conference spaces encourage useful, inclusive conversations.","name":"Alex Morgan","email":"alex.morgan@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:01:00.000Z', 'under_review'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1, 'seed-boundaries', '{"title":"Typed boundaries at scale","abstract":"How small explicit contracts keep large TypeScript systems understandable.","name":"Jordan Lee","email":"jordan.lee@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:02:00.000Z', 'submitted'),
  ('10000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 1, 'seed-calm-conference', '{"title":"Designing the calm conference","abstract":"A practical guide to reducing operational noise.","name":"Sam Speaker","email":"sam@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:05:00.000Z', 'accepted'),
  ('10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 1, 'seed-accessible-by-default', '{"title":"Accessible by default","abstract":"A hands-on guide to making conference experiences work for more attendees from the first sketch.","name":"Jordan Bell","email":"jordan.bell@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:06:00.000Z', 'accepted'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 1, 'seed-workshop', '{"title":"Workshop proposal","abstract":"A proposal for the secondary event without a configured review plan.","name":"Taylor Kim","email":"taylor.kim@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:03:00.000Z', 'submitted'),
  ('10000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000099', 1, 'seed-private', '{"title":"Private outside proposal","abstract":"This proposal must never cross event boundaries.","name":"Outside Author","email":"outside.author@example.test"}', '[{"id":"title","type":"short_text","label":"Proposal title"},{"id":"abstract","type":"long_text","label":"Abstract"},{"id":"name","type":"short_text","label":"Your name"},{"id":"email","type":"email","label":"Contact email"}]', '2026-08-09T12:04:00.000Z', 'submitted');

-- `accepted` and `declined` are the review domain's reserved decision statuses (migration 0021).
INSERT OR REPLACE INTO cfp_statuses (event_id, key, label, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'submitted', 'Submitted', 0),
  ('00000000-0000-4000-8000-000000000001', 'under_review', 'Under review', 1),
  ('00000000-0000-4000-8000-000000000001', 'reviewed', 'Reviewed', 2),
  ('00000000-0000-4000-8000-000000000001', 'withdrawn', 'Withdrawn', 3),
  ('00000000-0000-4000-8000-000000000001', 'accepted', 'Accepted', 90),
  ('00000000-0000-4000-8000-000000000001', 'declined', 'Declined', 91),
  ('00000000-0000-4000-8000-000000000002', 'submitted', 'Submitted', 0),
  ('00000000-0000-4000-8000-000000000002', 'accepted', 'Accepted', 90),
  ('00000000-0000-4000-8000-000000000002', 'declined', 'Declined', 91),
  ('00000000-0000-4000-8000-000000000099', 'submitted', 'Submitted', 0),
  ('00000000-0000-4000-8000-000000000099', 'accepted', 'Accepted', 90),
  ('00000000-0000-4000-8000-000000000099', 'declined', 'Declined', 91);

-- The seeded content sessions are program content because these decisions exist, not because
-- literal proposal ids were typed into `content_sessions`.
INSERT INTO review_decisions (event_id, proposal_id, outcome, decided_by, decided_at, note) VALUES
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 'accepted', 'seed-organizer', '2026-08-09T15:00:00.000Z', 'Strong fit for the operations track.'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'accepted', 'seed-organizer', '2026-08-09T15:05:00.000Z', 'The accessibility workshop the programme was missing.');

INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '[{"id":"relevance","name":"Relevance","description":"Fit for this audience","type":"numeric","minScore":1,"maxScore":5,"weight":2},{"id":"format","name":"Recommended format","description":"Choose the best delivery format","type":"dropdown","options":["Talk","Workshop","Panel"],"weight":1},{"id":"feedback","name":"Reviewer feedback","description":"Explain the recommendation","type":"text","maxLength":1000,"weight":1}]', '2026-08-09T12:00:00.000Z');

INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed-reviewer', 1, '2026-08-09T12:00:00.000Z');

INSERT INTO cfp_forms (event_id, title, description, fields_json, status, version, published_at, published_json)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Share your conference story',
  'Submit a practical session for Greenroom Demo Summit.',
  '[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"name","type":"short_text","label":"Your name","guidance":"How organizers should address you","required":false,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}]',
  'open',
  1,
  '2026-08-09T12:00:00.000Z',
  '{"eventId":"00000000-0000-4000-8000-000000000001","title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","fields":[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"name","type":"short_text","label":"Your name","guidance":"How organizers should address you","required":false,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}],"status":"open","version":1,"publishedAt":"2026-08-09T12:00:00.000Z","publishedStatus":"open"}'
);

INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES
  ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Dr. Ada Rivera','contacted','seed-organizer','Follow up on keynote topic','2026-08-08T17:00:00.000Z','2026-08-01T12:00:00.000Z','2026-08-05T12:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Morgan Chen','engaged','seed-organizer','Send formal invitation','2026-08-15T17:00:00.000Z','2026-08-02T12:00:00.000Z','2026-08-06T12:00:00.000Z'),
  -- The same person, courted again for the workshop day. This is the row that makes the
  -- directory's central claim demonstrable on a clean seed: one contact, two event histories.
  ('50000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','Dr. Ada Rivera','identified','seed-organizer','Confirm interest for the workshop day',NULL,'2026-08-07T12:00:00.000Z','2026-08-07T12:00:00.000Z');
INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES
  ('60000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','Ada Rivera','ada@example.test',1),
  ('60000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','Morgan Chen','morgan@example.test',1),
  ('60000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000003','Ada Rivera','ada@example.test',1);
INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES
  ('70000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','email','Introductory outreach sent',0,'2026-08-05T12:00:00.000Z','seed-organizer'),
  ('70000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','note','Interested in the responsible AI track',1,'2026-08-06T12:00:00.000Z','seed-organizer');

-- The organization-wide directory. Addresses are stored normalized, which is what the partial
-- unique index on (organization_id, email) relies on.
INSERT INTO crm_organization_contacts (id,organization_id,name,email,company,title,notes,source,merged_into_id,created_at,updated_at) VALUES
  ('51000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','Dr. Ada Rivera','ada@example.test','Northwind Access','Principal Engineer','Prefers a morning slot and a shared green room.','prospect',NULL,'2026-08-01T12:00:00.000Z','2026-08-07T12:00:00.000Z'),
  ('51000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000010','Morgan Chen','morgan@example.test','Southwind Labs','Staff Engineer',NULL,'prospect',NULL,'2026-08-02T12:00:00.000Z','2026-08-06T12:00:00.000Z'),
  ('51000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000010','Priya Raman','priya@example.test','Eastwind Studio','Design Lead',NULL,'import',NULL,'2026-08-03T12:00:00.000Z','2026-08-03T12:00:00.000Z'),
  -- Sourced from nowhere yet, and near-identical to Priya: the duplicate an organizer is meant
  -- to find and merge. Same name and company, a second address, so it is a *near* duplicate
  -- rather than one the unique index would have refused outright.
  ('51000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000010','Priya Raman','p.raman@eastwind.test','Eastwind Studio','Design Lead',NULL,'import',NULL,'2026-08-04T12:00:00.000Z','2026-08-04T12:00:00.000Z');

INSERT INTO crm_contact_tags (contact_id,tag) VALUES
  ('51000000-0000-4000-8000-000000000001','keynote'),
  ('51000000-0000-4000-8000-000000000001','accessibility'),
  ('51000000-0000-4000-8000-000000000002','workshop'),
  ('51000000-0000-4000-8000-000000000003','design'),
  ('51000000-0000-4000-8000-000000000004','design');

INSERT INTO crm_contact_fields (contact_id,field_key,field_value) VALUES
  ('51000000-0000-4000-8000-000000000001','topic','Inclusive event design'),
  ('51000000-0000-4000-8000-000000000001','timezone','America/Los_Angeles'),
  ('51000000-0000-4000-8000-000000000002','topic','Responsible AI'),
  ('51000000-0000-4000-8000-000000000003','topic','Wayfinding');

-- One person, both events, projected from the two prospects above.
INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) VALUES
  ('51000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','2026-08-01T12:00:00.000Z'),
  ('51000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000003','2026-08-07T12:00:00.000Z'),
  ('51000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','2026-08-02T12:00:00.000Z');

INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id) VALUES
  ('71000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','note','Met at the accessibility summit',1,'2026-08-01T12:00:00.000Z','seed-organizer'),
  ('71000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000001','note','Sourced into event 00000000-0000-4000-8000-000000000002',0,'2026-08-07T12:00:00.000Z','seed-organizer'),
  ('71000000-0000-4000-8000-000000000003','51000000-0000-4000-8000-000000000003','import','Imported from speakers-2026.csv',0,'2026-08-03T12:00:00.000Z','seed-organizer'),
  ('71000000-0000-4000-8000-000000000004','51000000-0000-4000-8000-000000000004','import','Imported from speakers-2026.csv',0,'2026-08-04T12:00:00.000Z','seed-organizer');

-- A saved view stores its definition, so it picks up contacts added after it was saved.
INSERT INTO crm_contact_segments (id,organization_id,name,definition_json,created_at,created_by) VALUES
  ('52000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','Design shortlist','{"tags":["design"]}','2026-08-04T12:00:00.000Z','seed-organizer');

INSERT INTO crm_contact_imports (id,organization_id,filename,row_count,created_count,updated_count,skipped_count,imported_at,imported_by) VALUES
  ('53000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','speakers-2026.csv',2,2,0,0,'2026-08-04T12:00:00.000Z','seed-organizer');


-- The published projection is exactly what `POST /api/publishing/events/{id}/publish` composes
-- from the seeded CFP, content, and agenda above, so a clean reset already shows the workspace
-- an organizer is touring and pressing Publish changes nothing. The property is enforced by
-- apps/api/test/d1-publication-repository.integration.test.ts, which recomputes it and compares.
INSERT INTO public_event_projections (event_id, slug, state, draft_json, published_json, published_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'greenroom-demo-summit',
  'published',
  '{"event":{"eventId":"00000000-0000-4000-8000-000000000001","slug":"greenroom-demo-summit","name":"Greenroom Demo Summit","summary":"A practical gathering for people building thoughtful, inclusive events.","startsOn":"2026-09-01","endsOn":"2026-09-01","timezone":"America/Los_Angeles","venue":"Harbor Conference Center, Oakland"},"cfp":{"title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","status":"open","publishedAt":"2026-08-09T12:00:00.000Z","submissionUrl":"/events/greenroom-demo-summit/cfp"},"sessions":[{"slug":"accessible-by-default","title":"Accessible by default","abstract":"A hands-on guide to making conference experiences work for more attendees from the first sketch.","format":"60-minute workshop","track":"Experience","speakerSlugs":["jordan-bell"]},{"slug":"designing-the-calm-conference","title":"Designing the calm conference","abstract":"A practical guide to reducing operational noise.","format":"45-minute talk","track":"Platform","speakerSlugs":["sam-speaker"],"startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z","room":"Main stage"}],"speakers":[{"slug":"jordan-bell","name":"Jordan Bell","bio":"Jordan works with event teams to create inclusive digital and physical experiences.","organization":"Northwind Access","photoUrl":"/api/speaker-assets/90000000-0000-4000-8000-000000000001"},{"slug":"sam-speaker","name":"Sam Speaker","bio":"Builds humane conference tools.","organization":"Greenroom Labs"}]}',
  '{"event":{"eventId":"00000000-0000-4000-8000-000000000001","slug":"greenroom-demo-summit","name":"Greenroom Demo Summit","summary":"A practical gathering for people building thoughtful, inclusive events.","startsOn":"2026-09-01","endsOn":"2026-09-01","timezone":"America/Los_Angeles","venue":"Harbor Conference Center, Oakland"},"cfp":{"title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","status":"open","publishedAt":"2026-08-09T12:00:00.000Z","submissionUrl":"/events/greenroom-demo-summit/cfp"},"sessions":[{"slug":"accessible-by-default","title":"Accessible by default","abstract":"A hands-on guide to making conference experiences work for more attendees from the first sketch.","format":"60-minute workshop","track":"Experience","speakerSlugs":["jordan-bell"]},{"slug":"designing-the-calm-conference","title":"Designing the calm conference","abstract":"A practical guide to reducing operational noise.","format":"45-minute talk","track":"Platform","speakerSlugs":["sam-speaker"],"startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z","room":"Main stage"}],"speakers":[{"slug":"jordan-bell","name":"Jordan Bell","bio":"Jordan works with event teams to create inclusive digital and physical experiences.","organization":"Northwind Access","photoUrl":"/api/speaker-assets/90000000-0000-4000-8000-000000000001"},{"slug":"sam-speaker","name":"Sam Speaker","bio":"Builds humane conference tools.","organization":"Greenroom Labs"}]}',
  '2026-08-10T20:00:00.000Z'
);
