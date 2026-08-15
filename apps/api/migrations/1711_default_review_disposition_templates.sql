-- Seed safe defaults for the new decision dispositions. Organizers may edit these through the
-- communications template surface before sending a later occurrence.
--
-- @spec PRD-REV-001 PRD-COM-001

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1711-' || o.id || '-decision-waitlisted', o.id, 'decision-waitlisted', 1, 'email',
  'An update about your proposal',
  'Hello {{submitterName}}, “{{proposalTitle}}” is on the programme waitlist. We will contact you when a place becomes available.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'decision-waitlisted'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1711-' || o.id || '-decision-revision-requested', o.id,
  'decision-revision-requested', 1, 'email',
  'A revision was requested for your proposal',
  'Hello {{submitterName}}, the programme team has requested a revision to “{{proposalTitle}}”. Sign in to review the decision note and update your proposal.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'decision-revision-requested'
);
