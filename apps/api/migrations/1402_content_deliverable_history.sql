ALTER TABLE speaker_assets ADD COLUMN task_id TEXT;
ALTER TABLE speaker_assets ADD COLUMN session_id TEXT;
ALTER TABLE speaker_assets ADD COLUMN version_group_id TEXT;
ALTER TABLE speaker_assets ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE speaker_assets ADD COLUMN is_latest INTEGER NOT NULL DEFAULT 1;
CREATE TABLE content_asset_comments (id TEXT PRIMARY KEY NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),asset_id TEXT NOT NULL REFERENCES speaker_assets(id),author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX content_asset_comments_asset_idx ON content_asset_comments(asset_id,created_at);
CREATE TABLE content_revisions (id TEXT PRIMARY KEY NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),entity_type TEXT NOT NULL CHECK (entity_type IN ('profile','session')),entity_id TEXT NOT NULL,revision_number INTEGER NOT NULL,snapshot_json TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,restored_from_revision_id TEXT,UNIQUE(entity_type,entity_id,revision_number));
CREATE INDEX content_revisions_entity_idx ON content_revisions(entity_type,entity_id,revision_number);
