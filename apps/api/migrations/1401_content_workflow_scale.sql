ALTER TABLE speaker_profiles ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'onboarding' CHECK (workflow_status IN ('invited','onboarding','ready','blocked'));
ALTER TABLE speaker_profiles ADD COLUMN logistics_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE speaker_profiles ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE speaker_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'general' CHECK (task_type IN ('general','file-request'));
ALTER TABLE speaker_tasks ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE speaker_tasks ADD COLUMN session_id TEXT;
