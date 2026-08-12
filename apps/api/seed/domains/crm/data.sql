

INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES
  ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Dr. Ada Rivera','contacted','seed-organizer','Follow up on keynote topic','2026-08-08T17:00:00.000Z','2026-08-01T12:00:00.000Z','2026-08-05T12:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Morgan Chen','engaged','seed-organizer','Send formal invitation','2026-08-15T17:00:00.000Z','2026-08-02T12:00:00.000Z','2026-08-06T12:00:00.000Z');
INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES
  ('60000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','Ada Rivera','ada@example.test',1),
  ('60000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','Morgan Chen','morgan@example.test',1);
INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES
  ('70000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','email','Introductory outreach sent',0,'2026-08-05T12:00:00.000Z','seed-organizer'),
  ('70000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','note','Interested in the responsible AI track',1,'2026-08-06T12:00:00.000Z','seed-organizer');