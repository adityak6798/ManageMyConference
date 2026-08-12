
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