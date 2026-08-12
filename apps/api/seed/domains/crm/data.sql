

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
