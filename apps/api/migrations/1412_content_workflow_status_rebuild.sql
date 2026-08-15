-- Drop the fixed workflow-status CHECK after `1411` made the vocabulary data.
--
-- The CRM precedent rebuilt its parent because SQLite cannot drop a table CHECK directly. This
-- parent now has five direct children across two domains plus grandchildren; rebuilding it would
-- have to be placed both before and after CRM's migration block to work on fresh and deployed
-- databases. Rotate just the checked column instead: rename preserves its value and CHECK, add
-- the unconstrained canonical column, copy, then drop the legacy column and its self-contained
-- CHECK. No table identity moves, so every child FK and trigger remains attached throughout.
--
-- @owner content
-- @spec PRD-SPK-001 PRD-SPK-002 ARC-003

ALTER TABLE speaker_profiles RENAME COLUMN workflow_status TO legacy_workflow_status;
ALTER TABLE speaker_profiles ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'onboarding';
UPDATE speaker_profiles SET workflow_status = legacy_workflow_status;
ALTER TABLE speaker_profiles DROP COLUMN legacy_workflow_status;
