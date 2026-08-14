
-- Jordan carries the seeded headshot so the public gallery demonstrates both avatar
-- paths — a real portrait and a monogram — and so Sam's open "Upload a headshot" task
-- still describes work that is genuinely outstanding. Neither profile names a photo here:
-- the pairing is made below, from the uploads, the way the product makes it.
INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','seed-speaker','proposal-person-sam','Sam Speaker','sam@example.test','Builds humane conference tools.','they/them','Greenroom Labs',NULL),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','speaker-jordan-bell','proposal-person-jordan','Jordan Bell','jordan.bell@example.test','Jordan works with event teams to create inclusive digital and physical experiences.','she/her','Northwind Access',NULL);
-- `npm run reset` also writes these bytes into the local R2 bucket under `storage_key`,
-- so an anonymous GET /api/speaker-assets/<id> serves a real image from a clean seed.
--
-- The two version columns are stated here rather than left to the backfill in migration `1406`:
-- a seed is applied after every migration on every path, so that backfill can never see this row,
-- and it would carry no logical key at all. Re-uploading a file of the same name then finds no
-- chain to join and stores a second v1 instead of a v2 — the CNT-04 defect — on every seeded
-- database, the hosted demo included. `logical_key` is what `logicalAssetKey` in
-- src/domain/content/content.ts derives for an upload naming neither a task nor a session, the
-- trimmed and lowercased file name, and `version_group_id` repeats this row id, which is the group
-- the repository gives a first version. `version_number` and `is_latest` default to 1 and are left
-- to the schema.
INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at,logical_key,version_group_id) VALUES
('90000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','jordan-bell-portrait.png','image/png','00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/90000000-0000-4000-8000-000000000001','publishable','2026-08-10T17:00:00.000Z','name:jordan-bell-portrait.png','90000000-0000-4000-8000-000000000001');
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
-- The checklist those two tasks came from. A line belongs to the event rather than to a person,
-- so it stays here until POST /api/events/{eventId}/speaker-checklist-assignments turns it into
-- dated work for named speakers. The third line is deliberately assigned to nobody, so the demo
-- can show that command bringing one speaker up to date without disturbing the work above, and
-- so cloning this event into next year carries a checklist that is genuinely there.
INSERT INTO speaker_task_templates (id,event_id,title,description,sort_order,due_offset_days,created_at) VALUES
('42000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Confirm profile details','Check your name, pronouns and organization in the speaker portal.',0,-21,'2026-08-10T16:00:00.000Z'),
('42000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Upload a headshot','A square image, at least 800px on each side.',1,-14,'2026-08-10T16:00:00.000Z'),
('42000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Send your slides','A PDF at 16:9, uploaded against your session.',2,-7,'2026-08-10T16:00:00.000Z');
INSERT INTO speaker_messages (id,event_id,speaker_profile_id,subject,sent_at) VALUES
('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Welcome to Greenroom Demo Summit','2026-08-10T16:00:00.000Z');
INSERT INTO speaker_resources (id,event_id,title,slug,body_html,embed_html,visibility,sort_order) VALUES
('41000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Speaker handbook','speaker-handbook','<h2>Welcome to Greenroom</h2><p>Use this portal to finish your tasks and share deliverables.</p>','','visible',0);
