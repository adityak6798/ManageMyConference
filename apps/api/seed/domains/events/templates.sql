

-- One reusable template captured from Greenroom Demo Summit, so the demo has something to
-- preview and apply without an organizer having to save one first.
--
-- The payload below is not hand-written. It is exactly what the six slices produced when this
-- template was captured from the seeded event through the running Worker, read back out of
-- `event_template_versions` and pasted here — which is the only way it stays a true statement
-- about what a capture contains. Regenerate it the same way if a slice's payload shape changes.
--
-- Note what is in it and what is not: triage statuses, a rubric, a CFP form, rooms, tracks,
-- slots, a public summary and venue, one portal resource and three checklist entries. No
-- submission, no evaluation, no decision, no person, no published snapshot, no address.
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
  '{"capturedAt":"2026-08-11T09:00:00.000Z","source":{"eventId":"00000000-0000-4000-8000-000000000001","eventName":"Greenroom Demo Summit","timezone":"America/Los_Angeles"},"slices":{"review":{"statuses":[{"key":"submitted","label":"Submitted","sortOrder":0},{"key":"under_review","label":"Under review","sortOrder":1},{"key":"reviewed","label":"Reviewed","sortOrder":2},{"key":"withdrawn","label":"Withdrawn","sortOrder":3},{"key":"accepted","label":"Accepted","sortOrder":90},{"key":"declined","label":"Declined","sortOrder":91}],"criteria":[{"id":"relevance","name":"Relevance","description":"Fit for this audience","type":"numeric","minScore":1,"maxScore":5,"weight":2},{"id":"format","name":"Recommended format","description":"Choose the best delivery format","type":"dropdown","options":["Talk","Workshop","Panel"],"weight":1},{"id":"feedback","name":"Reviewer feedback","description":"Explain the recommendation","type":"text","maxLength":1000,"weight":1}]},"cfp":{"title":"Share your conference story","description":"Submit a practical session for Greenroom Demo Summit.","fields":[{"id":"title","type":"short_text","label":"Proposal title","guidance":"Keep it specific","required":true,"options":[]},{"id":"abstract","type":"long_text","label":"Abstract","guidance":"What will attendees learn?","required":true,"options":[]},{"id":"name","type":"short_text","label":"Your name","guidance":"How organizers should address you","required":false,"options":[]},{"id":"email","type":"email","label":"Contact email","guidance":"We will send your confirmation here","required":true,"options":[]}],"routing":[]},"agenda":{"rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"},{"id":"track-practice","name":"Practice","color":"#16866b"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"},{"id":"slot-1000","startsAt":"2026-09-01T17:00:00.000Z","endsAt":"2026-09-01T18:00:00.000Z"}]},"publishing":{"summary":"A practical gathering for people building thoughtful, inclusive events.","venue":"Harbor Conference Center, Oakland"},"content-resources":{"resources":[{"title":"Speaker handbook","slug":"speaker-handbook","bodyHtml":"<h2>Welcome to Greenroom</h2><p>Use this portal to finish your tasks and share deliverables.</p>","embedHtml":"","visibility":"visible","sortOrder":0}]},"content-checklists":{"templates":[{"title":"Confirm profile details","description":"Check your name, pronouns and organization in the speaker portal.","sortOrder":0,"dueOffsetDays":-21},{"title":"Upload a headshot","description":"A square image, at least 800px on each side.","sortOrder":1,"dueOffsetDays":-14},{"title":"Send your slides","description":"A PDF at 16:9, uploaded against your session.","sortOrder":2,"dueOffsetDays":-7}]}}}',
  '2026-08-11T09:00:00.000Z',
  'seed-organizer'
);
