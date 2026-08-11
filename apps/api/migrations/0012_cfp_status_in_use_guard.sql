CREATE TRIGGER cfp_status_delete_rejects_in_use
BEFORE DELETE ON cfp_statuses
WHEN EXISTS (
  SELECT 1 FROM cfp_submissions
  WHERE event_id = OLD.event_id AND status = OLD.key
)
BEGIN
  SELECT RAISE(ABORT, 'CFP_STATUS_IN_USE');
END;
