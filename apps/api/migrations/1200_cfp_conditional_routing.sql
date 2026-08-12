ALTER TABLE cfp_forms ADD COLUMN routing_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cfp_submissions ADD COLUMN resolved_route_json TEXT;

CREATE TRIGGER cfp_submission_route_status_guard
BEFORE INSERT ON cfp_submissions
WHEN NEW.resolved_route_json IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM cfp_statuses
    WHERE event_id = NEW.event_id AND key = NEW.status
  )
BEGIN
  SELECT RAISE(ABORT, 'CFP_ROUTE_STATUS_NOT_CONFIGURED');
END;

CREATE TRIGGER cfp_route_status_delete_guard
BEFORE DELETE ON cfp_statuses
WHEN EXISTS (
  SELECT 1
  FROM cfp_forms, json_each(cfp_forms.routing_json)
  WHERE cfp_forms.event_id = OLD.event_id
    AND json_extract(json_each.value, '$.routeTo.status') = OLD.key
  UNION ALL
  SELECT 1
  FROM cfp_forms, json_each(COALESCE(json_extract(cfp_forms.published_json, '$.routing'), '[]'))
  WHERE cfp_forms.event_id = OLD.event_id
    AND json_extract(json_each.value, '$.routeTo.status') = OLD.key
)
BEGIN
  SELECT RAISE(ABORT, 'CFP_STATUS_IN_USE');
END;

CREATE TRIGGER cfp_form_route_insert_guard
BEFORE INSERT ON cfp_forms
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.routing_json)
  WHERE NOT EXISTS (
    SELECT 1 FROM cfp_statuses
    WHERE event_id = NEW.event_id
      AND key = json_extract(json_each.value, '$.routeTo.status')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'CFP_ROUTE_STATUS_NOT_CONFIGURED');
END;

CREATE TRIGGER cfp_form_route_update_guard
BEFORE UPDATE OF routing_json ON cfp_forms
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.routing_json)
  WHERE NOT EXISTS (
    SELECT 1 FROM cfp_statuses
    WHERE event_id = NEW.event_id
      AND key = json_extract(json_each.value, '$.routeTo.status')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'CFP_ROUTE_STATUS_NOT_CONFIGURED');
END;
