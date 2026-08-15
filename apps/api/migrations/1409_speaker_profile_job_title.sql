-- @owner content
-- @spec PRD-SPK-001 PRD-CNT-001
-- @issue #224

-- Company already has one canonical field (`organization`). Job title is distinct profile data
-- and defaults empty so profiles created before organizer editing remain valid.
ALTER TABLE speaker_profiles ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
