-- @owner content
-- @spec PRD-SPK-001
-- @issue #224

-- Before this invariant existed, restoring a revision after deleting its headshot could leave
-- the profile naming an asset row that was already gone. Repair those deployed rows first; the
-- trigger below would otherwise make every later canonical profile edit repeat that conflict.
UPDATE speaker_profiles
   SET photo_asset_id = NULL
 WHERE photo_asset_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM speaker_assets
      WHERE id = speaker_profiles.photo_asset_id
        AND speaker_profile_id = speaker_profiles.id
   );

-- A restored revision and a headshot selection both name an asset read before the profile write.
-- Decide the reference from committed rows: the asset must still exist and still belong to this
-- profile when the choice lands.
CREATE TRIGGER speaker_profile_photo_requires_owned_asset
BEFORE UPDATE OF photo_asset_id ON speaker_profiles
FOR EACH ROW
WHEN NEW.photo_asset_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM speaker_assets
    WHERE id = NEW.photo_asset_id
      AND speaker_profile_id = NEW.id
 )
BEGIN
  SELECT RAISE(ABORT, 'profile photo asset does not exist');
END;

-- Metadata deletion normally follows storage deletion. If a concurrent profile revision chose
-- the asset in between, refuse the bare delete so the repository can retry through the canonical
-- revision seam and clear exactly the committed choice before deleting the row.
CREATE TRIGGER speaker_asset_delete_rejects_profile_photo
BEFORE DELETE ON speaker_assets
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM speaker_profiles
   WHERE photo_asset_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'profile still references asset');
END;
