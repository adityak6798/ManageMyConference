DELETE FROM agenda_session_schedules;
-- Before the publications, so the delete trigger `1602` declares has nothing left to invalidate.
-- It also has to be before the events cleanup below: this table references events(id) and does not
-- cascade, so leaving a row behind fails the reset with a bare FOREIGN KEY constraint failure that
-- names no table.
DELETE FROM agenda_schedule_materializations;
DELETE FROM agenda_publications;
DELETE FROM agenda_drafts;