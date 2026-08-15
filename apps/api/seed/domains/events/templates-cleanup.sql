-- Applications reference versions, versions reference templates and events, so they go first.
-- Scoped through the templates the last statement deletes, plus the events the applications point
-- at: an application recorded against a demo event has to go even if its template belongs to a
-- real organization, or the events cleanup below fails on it.
DELETE FROM event_template_applications
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
)
  OR template_version_id IN (
    SELECT id FROM event_template_versions
    WHERE template_id IN (
      SELECT id FROM event_templates
      WHERE organization_id IN (
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000020'
      )
    )
  );
DELETE FROM event_template_versions
WHERE template_id IN (
  SELECT id FROM event_templates
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
)
  OR source_event_id IN (
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  );
DELETE FROM event_templates
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
