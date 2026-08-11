CREATE TRIGGER cfp_transition_requires_configured_status
BEFORE UPDATE OF status ON cfp_submissions
WHEN NOT EXISTS (
  SELECT 1 FROM cfp_statuses
  WHERE event_id = NEW.event_id AND key = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'CFP_STATUS_NOT_CONFIGURED');
END;
