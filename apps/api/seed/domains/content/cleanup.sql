
DELETE FROM speaker_resources;
DELETE FROM speaker_task_templates;
DELETE FROM content_asset_comments;
DELETE FROM content_revisions;
DELETE FROM content_speaker_import_rows;
DELETE FROM speaker_conversion_sources;
DELETE FROM speaker_conversion_claims;
DELETE FROM speaker_email_claims;
DELETE FROM speaker_messages;
-- The committed photo invariant refuses to delete an asset while a profile names it.
-- Reset owns both sides, so clear the selection before deleting the asset rows.
UPDATE speaker_profiles SET photo_asset_id = NULL WHERE photo_asset_id IS NOT NULL;
DELETE FROM speaker_assets;
DELETE FROM speaker_tasks;
DELETE FROM content_sessions;
DELETE FROM speaker_profiles;
