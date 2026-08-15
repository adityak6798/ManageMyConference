-- Owner: content
-- @spec PRD-CNT-001
-- CFP classification identifiers remain distinct from their mutable presentation labels.
ALTER TABLE content_sessions ADD COLUMN source_track_id TEXT;
ALTER TABLE content_sessions ADD COLUMN source_format_id TEXT;

