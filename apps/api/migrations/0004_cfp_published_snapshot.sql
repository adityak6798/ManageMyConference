ALTER TABLE cfp_forms ADD COLUMN published_json TEXT;
UPDATE cfp_forms
SET published_json = json_object(
  'eventId', event_id, 'title', title, 'description', description,
  'fields', json(fields_json), 'status', status, 'version', version,
  'publishedAt', published_at
)
WHERE status IN ('open', 'closed');
