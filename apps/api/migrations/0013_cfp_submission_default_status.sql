CREATE TRIGGER cfp_submission_initializes_default_status
BEFORE INSERT ON cfp_submissions
BEGIN
  INSERT OR IGNORE INTO cfp_statuses (event_id, key, label, sort_order)
  VALUES (NEW.event_id, 'submitted', 'Submitted', 0);
END;
