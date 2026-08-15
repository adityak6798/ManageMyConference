-- Review-round controls left after first-class rounds: instructions, stable proposal-filter
-- snapshots, reviewer projection visibility, per-proposal caps, invitations and weekly reminders.
--
-- @spec PRD-REV-001 PRD-ABS-001

ALTER TABLE review_rounds ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE review_rounds ADD COLUMN filters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(filters_json));
ALTER TABLE review_rounds ADD COLUMN included_proposal_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(included_proposal_ids_json));
ALTER TABLE review_rounds ADD COLUMN filter_version INTEGER NOT NULL DEFAULT 1 CHECK (filter_version > 0);
ALTER TABLE review_rounds ADD COLUMN visible_field_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(visible_field_ids_json));
ALTER TABLE review_rounds ADD COLUMN files_visible INTEGER NOT NULL DEFAULT 0 CHECK (files_visible IN (0, 1));
ALTER TABLE review_rounds ADD COLUMN max_evaluations_per_proposal INTEGER NOT NULL DEFAULT 100 CHECK (max_evaluations_per_proposal BETWEEN 1 AND 100);
ALTER TABLE review_rounds ADD COLUMN weekly_reminder_weekday INTEGER CHECK (weekly_reminder_weekday BETWEEN 0 AND 6);
ALTER TABLE review_rounds ADD COLUMN weekly_reminder_hour INTEGER CHECK (weekly_reminder_hour BETWEEN 0 AND 23);
ALTER TABLE review_rounds ADD COLUMN reminder_timezone TEXT;
ALTER TABLE review_rounds ADD COLUMN invitation_occurrence INTEGER NOT NULL DEFAULT 0 CHECK (invitation_occurrence >= 0);

-- A non-empty snapshot is the exact membership the organizer previewed. It moves only through an
-- explicit recomputation command, so a later CFP edit cannot silently add or remove work.
CREATE TRIGGER review_assignment_requires_filter_membership
BEFORE INSERT ON review_assignments
WHEN json_array_length((
  SELECT included_proposal_ids_json FROM review_rounds
  WHERE event_id = NEW.event_id AND sequence = NEW.round
)) > 0
AND NOT EXISTS (
  SELECT 1 FROM json_each((
    SELECT included_proposal_ids_json FROM review_rounds
    WHERE event_id = NEW.event_id AND sequence = NEW.round
  )) WHERE value = NEW.proposal_id
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_ROUND_FILTER'); END;

-- Count and insert are one SQLite statement, so concurrent distributors cannot both admit the
-- last slot. The per-reviewer cap remains the separate `review_assignment_cap` rule.
CREATE TRIGGER review_assignment_proposal_cap
BEFORE INSERT ON review_assignments
WHEN (
  SELECT COUNT(*) FROM review_assignments
  WHERE event_id = NEW.event_id AND proposal_id = NEW.proposal_id AND round = NEW.round
) >= (
  SELECT max_evaluations_per_proposal FROM review_rounds
  WHERE event_id = NEW.event_id AND sequence = NEW.round
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_PROPOSAL_CAP'); END;

-- `1312` froze the original round terms. Restate it with every new term: reopening a historical
-- round must not permit changing what reviewers were told, shown, admitted to, or capped by.
DROP TRIGGER review_round_closed_terms_locked;
CREATE TRIGGER review_round_closed_terms_locked
BEFORE UPDATE OF criteria_json, anonymized, opens_at, closes_at, pool_mode, instructions,
  filters_json, included_proposal_ids_json, filter_version, visible_field_ids_json, files_visible,
  max_evaluations_per_proposal, weekly_reminder_weekday, weekly_reminder_hour, reminder_timezone
ON review_rounds
WHEN OLD.state = 'closed' AND (
  OLD.criteria_json IS NOT NEW.criteria_json OR OLD.anonymized != NEW.anonymized
  OR OLD.opens_at IS NOT NEW.opens_at OR OLD.closes_at IS NOT NEW.closes_at
  OR OLD.pool_mode != NEW.pool_mode OR OLD.instructions != NEW.instructions
  OR OLD.filters_json != NEW.filters_json
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
