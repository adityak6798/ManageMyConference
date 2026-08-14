-- CRM has two roots and they are scoped differently, which is why this file is longer than the
-- rest: `crm_prospects` belongs to an **event** and `crm_organization_contacts` belongs to an
-- **organization**. Every table below reaches one of those two, and each is scoped through the
-- parent whose rows this reset actually deletes — so a row belonging to a real conference on the
-- same deployment is left where it is, and no child outlives the parent it points at.
DELETE FROM crm_contact_activities
WHERE contact_id IN (
  SELECT id FROM crm_organization_contacts
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM crm_contact_aliases
WHERE contact_id IN (
  SELECT id FROM crm_organization_contacts
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
-- Three foreign keys, and the row has to go when **any** of them is being deleted: it points at a
-- contact, an event and a prospect, and surviving the loss of any one of them is the foreign-key
-- failure this file exists to prevent.
DELETE FROM crm_contact_events
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
)
  OR contact_id IN (
    SELECT id FROM crm_organization_contacts
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  )
  OR prospect_id IN (
    SELECT id FROM crm_prospects
    WHERE event_id IN (
      SELECT id FROM events
      WHERE organization_id IN (
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000020'
      )
    )
  );
DELETE FROM crm_contact_fields
WHERE contact_id IN (
  SELECT id FROM crm_organization_contacts
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM crm_contact_tags
WHERE contact_id IN (
  SELECT id FROM crm_organization_contacts
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM crm_contact_segments
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM crm_contact_imports
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM crm_organization_contacts
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM crm_activities
WHERE prospect_id IN (
  SELECT id FROM crm_prospects
  WHERE event_id IN (
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  )
);
DELETE FROM crm_contacts
WHERE prospect_id IN (
  SELECT id FROM crm_prospects
  WHERE event_id IN (
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  )
);
-- The pipeline pair from migration `1501`, both event-scoped, in the order that file's own
-- references require: a transition before the prospect it describes, and the stage list after the
-- prospects that name a stage.
DELETE FROM crm_prospect_transitions
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM crm_prospects
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM crm_pipeline_stages
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
