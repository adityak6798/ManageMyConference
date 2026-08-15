-- @owner platform
-- @spec PRD-OPS-003
-- @issue #224

-- Revisioned targets keep their canonical version on the shared platform timeline. Nullable:
-- most lifecycle facts are not versioned, and old append-only records must remain unchanged.
ALTER TABLE platform_audit_records ADD COLUMN target_version INTEGER;
