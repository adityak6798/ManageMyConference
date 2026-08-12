DELETE FROM public_event_projections;
DELETE FROM outbound_projection_state;
DELETE FROM communication_attempts;
DELETE FROM communication_deliveries;
DELETE FROM message_templates;
DELETE FROM agenda_publications;
DELETE FROM agenda_drafts;
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
DELETE FROM review_evaluations;
DELETE FROM review_conflicts;
DELETE FROM review_assignments;
DELETE FROM review_plans;
DELETE FROM cfp_status_audit;
DELETE FROM cfp_submissions;
DELETE FROM cfp_statuses;
DELETE FROM cfp_forms;
DELETE FROM event_roles;
DELETE FROM organization_memberships;
DELETE FROM events;
DELETE FROM identity_login_challenges;
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

INSERT INTO event_roles (event_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-organizer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000002', 'seed-organizer', 'organizer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-reviewer', 'reviewer'),
  ('00000000-0000-4000-8000-000000000001', 'seed-speaker', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'speaker-jordan-bell', 'speaker'),
  ('00000000-0000-4000-8000-000000000001', 'seed-public', 'public');

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
  ('00000000-0000-4000-8000-000000000001', '[{"id":"relevance","name":"Relevance","description":"Fit for this audience","minScore":1,"maxScore":5},{"id":"clarity","name":"Clarity","description":"Strength and clarity of the proposal","minScore":1,"maxScore":5}]', '2026-08-09T12:00:00.000Z');

INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, created_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed-reviewer', '2026-08-09T12:00:00.000Z');
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
  ('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Morgan Chen','engaged','seed-organizer','Send formal invitation','2026-08-15T17:00:00.000Z','2026-08-02T12:00:00.000Z','2026-08-06T12:00:00.000Z');
INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES
  ('60000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','Ada Rivera','ada@example.test',1),
  ('60000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','Morgan Chen','morgan@example.test',1);
INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES
  ('70000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','email','Introductory outreach sent',0,'2026-08-05T12:00:00.000Z','seed-organizer'),
  ('70000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','note','Interested in the responsible AI track',1,'2026-08-06T12:00:00.000Z','seed-organizer');

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
