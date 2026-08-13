

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
