-- Organizer guidance for AI evaluator drafts. It is round configuration, never a human score.
-- @owner review
-- @spec PRD-AI-001 PRD-REV-001
ALTER TABLE review_rounds ADD COLUMN ai_persona TEXT NOT NULL DEFAULT '';
DROP TRIGGER review_round_closed_terms_locked;
CREATE TRIGGER review_round_closed_terms_locked
BEFORE UPDATE OF criteria_json, anonymized, opens_at, closes_at, pool_mode, instructions,
  ai_persona, filters_json, included_proposal_ids_json, filter_version, visible_field_ids_json,
  files_visible, max_evaluations_per_proposal, weekly_reminder_weekday, weekly_reminder_hour,
  reminder_timezone
ON review_rounds
WHEN OLD.state = 'closed' AND (
  OLD.criteria_json IS NOT NEW.criteria_json OR OLD.anonymized != NEW.anonymized
  OR OLD.opens_at IS NOT NEW.opens_at OR OLD.closes_at IS NOT NEW.closes_at
  OR OLD.pool_mode != NEW.pool_mode OR OLD.instructions != NEW.instructions
  OR OLD.ai_persona != NEW.ai_persona OR OLD.filters_json != NEW.filters_json
  OR OLD.included_proposal_ids_json != NEW.included_proposal_ids_json
  OR OLD.filter_version != NEW.filter_version
  OR OLD.visible_field_ids_json != NEW.visible_field_ids_json
  OR OLD.files_visible != NEW.files_visible
  OR OLD.max_evaluations_per_proposal != NEW.max_evaluations_per_proposal
  OR OLD.weekly_reminder_weekday IS NOT NEW.weekly_reminder_weekday
  OR OLD.weekly_reminder_hour IS NOT NEW.weekly_reminder_hour
  OR OLD.reminder_timezone IS NOT NEW.reminder_timezone
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_CLOSED'); END;
