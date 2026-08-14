-- The logical deliverable an upload belongs to, so a re-upload is a version rather than a twin.
--
-- The version *group* was already modelled; what was missing is how an upload finds its group
-- when the client does not name one. A speaker uploading `slides.pdf` twice from the portal sent
-- no `versionGroupId` and no task, so each upload minted its own group and the pair stored as two
-- separate v1 assets — the evaluator's CNT-04 failure, and undetectable from the portal, which
-- listed both rows under the same name with nothing marking either as current.
--
-- Deriving the group at read time cannot fix it. Two uploads arriving together both read "no
-- previous version" and both mint a group, which is the same defect one race narrower. The key is
-- therefore stored, and the group and the version number are both allocated *inside* the insert
-- against it (`d1-content-repository.ts`), so the second upload sees the first's row or does not
-- commit. That is the same shape `1311` uses for a decision's revision.
ALTER TABLE speaker_assets ADD COLUMN logical_key TEXT;

-- Reads are always "the versions of this deliverable, newest first".
CREATE INDEX speaker_assets_logical_idx
  ON speaker_assets(event_id, speaker_profile_id, logical_key, version_number);

-- Backfill in the same shape the application derives, so rows written before this migration join
-- the chain their next upload allocates against rather than starting a second one.
--
-- A task is the strongest statement of logical identity available: a file-request task *is* one
-- requested deliverable, so replacing `deck.pdf` with `deck-final.pdf` against it is a new
-- version of the same thing. Without a task the name is what the person means by "the same
-- file", scoped to a session when the upload names one.
--
-- Rows already grouped keep their existing group's key, so an explicit `versionGroupId`
-- continuation that renamed the file is not split apart by this backfill: every member of a
-- group takes the key derived from the group's *first* version.
UPDATE speaker_assets
SET logical_key = (
  SELECT CASE
    WHEN first.task_id IS NOT NULL THEN 'task:' || first.task_id
    WHEN first.session_id IS NOT NULL THEN 'session:' || first.session_id || '|name:' || lower(trim(first.name))
    ELSE 'name:' || lower(trim(first.name))
  END
  FROM speaker_assets AS first
  WHERE first.version_group_id = COALESCE(speaker_assets.version_group_id, speaker_assets.id)
  ORDER BY first.version_number ASC
  LIMIT 1
)
WHERE logical_key IS NULL;

-- Rows with no group at all — written before `1402` added the column — key off themselves.
UPDATE speaker_assets
SET logical_key = CASE
  WHEN task_id IS NOT NULL THEN 'task:' || task_id
  WHEN session_id IS NOT NULL THEN 'session:' || session_id || '|name:' || lower(trim(name))
  ELSE 'name:' || lower(trim(name))
END
WHERE logical_key IS NULL;
