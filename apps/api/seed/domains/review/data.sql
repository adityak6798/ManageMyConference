

-- The seeded content sessions are program content because these decisions exist, not because
-- literal proposal ids were typed into `content_sessions`.
INSERT INTO review_decisions (event_id, proposal_id, outcome, decided_by, decided_at, note) VALUES
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 'accepted', 'seed-organizer', '2026-08-09T15:00:00.000Z', 'Strong fit for the operations track.'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'accepted', 'seed-organizer', '2026-08-09T15:05:00.000Z', 'The accessibility workshop the programme was missing.');

INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '[{"id":"relevance","name":"Relevance","description":"Fit for this audience","type":"numeric","minScore":1,"maxScore":5,"weight":2},{"id":"format","name":"Recommended format","description":"Choose the best delivery format","type":"dropdown","options":["Talk","Workshop","Panel"],"weight":1},{"id":"feedback","name":"Reviewer feedback","description":"Explain the recommendation","type":"text","maxLength":1000,"weight":1}]', '2026-08-09T12:00:00.000Z');

INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed-reviewer', 1, '2026-08-09T12:00:00.000Z');
