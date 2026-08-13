-- Reusable speaker checklists, owned by the event rather than by a person.
--
-- speaker_tasks.speaker_profile_id is NOT NULL: every task is somebody's work. A checklist line
-- is nobody's until an organizer instantiates it, so it lives in its own table instead of being
-- a task with the owner left out.
CREATE TABLE speaker_task_templates (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  -- A distance rather than a date: an event has no date range of its own, so the due date is
  -- derived when the checklist is instantiated, from the anchor that caller names.
  due_offset_days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- The title is a line's identity across events. Ids are minted per event, so a checklist
  -- cloned into next year's conference has nothing else to converge on, and re-cloning it
  -- would otherwise append a second copy of every line.
  UNIQUE(event_id, title)
);
CREATE INDEX speaker_task_templates_event_order_idx ON speaker_task_templates(event_id, sort_order);
