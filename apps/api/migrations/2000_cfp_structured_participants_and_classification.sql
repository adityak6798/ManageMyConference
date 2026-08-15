-- Owner: cfp
-- @spec PRD-CFP-004 PRD-ABS-001
-- Structured participant and classification metadata travels with the proposal snapshot. Existing
-- rows remain valid: an empty participant list is honest, and NULL classification ids explicitly
-- mean that a legacy answer cannot be promoted from a display label into a stable identifier.
ALTER TABLE cfp_submissions ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cfp_submissions ADD COLUMN track_id TEXT;
ALTER TABLE cfp_submissions ADD COLUMN format_id TEXT;

