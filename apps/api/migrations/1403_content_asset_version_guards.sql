CREATE UNIQUE INDEX speaker_assets_version_unique ON speaker_assets(version_group_id,version_number) WHERE version_group_id IS NOT NULL;
CREATE UNIQUE INDEX speaker_assets_latest_unique ON speaker_assets(version_group_id) WHERE version_group_id IS NOT NULL AND is_latest=1;
