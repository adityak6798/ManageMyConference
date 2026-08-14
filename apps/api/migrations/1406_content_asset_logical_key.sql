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
--
-- Only names SQLite can fold *identically* to `logicalAssetKey`
-- (`src/domain/content/content.ts`) are keyed here, and that means names made entirely of ASCII.
-- SQLite's `lower()` is ASCII-only unless the build carries ICU, and D1's does not, so `ÉTUDE.pdf`
-- keys as `name:Étude.pdf` here and as `name:étude.pdf` in the application — a key the next upload
-- can never match, which is the split chain this migration exists to prevent. The two-argument
-- `trim` closes the other half of the disagreement: one-argument `trim()` strips U+0020 alone,
-- while `String.prototype.trim` also strips tab, LF, VT, FF and CR (the six passed to `char()`
-- below). Everything else it strips — NBSP, U+2000-200A, U+FEFF and the rest — is non-ASCII, so
-- the ASCII test already excludes those names. The test is blunter than the disagreement it
-- guards: `étude.pdf` is folded and trimmed already, so both sides would in fact agree about it.
-- Recognising that is the case knowledge SQLite is missing, so it is skipped with the rest rather
-- than guessed at.
--
-- The other way to make the two sides agree is to fold ASCII-only in the application too. That is
-- rejected: it would permanently stop `ÉTUDE.pdf` and `étude.pdf` being one deliverable for every
-- *future* upload, and it would still disagree about trimming unless the domain also reimplemented
-- SQLite's `trim` — a lasting narrowing of a product rule, bought to simplify a one-off backfill.
--
-- A skipped row keeps `logical_key NULL`, which is exactly where this migration found it and a
-- state the code already reads: `d1-content-repository` maps NULL to `logicalKey: undefined`, and
-- `replaceLatestAsset` scopes its lookup by `logical_key = ?`, which no NULL row matches. So a
-- re-upload of a non-ASCII name mints its own chain exactly as it did before this migration —
-- CNT-04 still open for those stored rows, and closed for every row written after it, because the
-- application supplies the key on every insert. That is the better failure: a mismatched key is
-- indistinguishable from a correct one, so it would be believed by whatever repairs this next and
-- would guarantee the split chain forever, whereas `WHERE logical_key IS NULL` names the residual
-- and can be re-keyed later by the application's own function, which is the only thing that knows
-- how to fold those names.
UPDATE speaker_assets
SET logical_key = (
  SELECT CASE
    -- No name reaches the key, so a task row is exact whatever the file is called.
    WHEN first.task_id IS NOT NULL THEN 'task:' || first.task_id
    -- More bytes than characters means at least one character is outside ASCII, and `lower()`
    -- would leave its case standing where the application folds it.
    WHEN length(first.name) <> length(CAST(first.name AS BLOB)) THEN NULL
    WHEN first.session_id IS NOT NULL
      THEN 'session:' || first.session_id
        || '|name:' || lower(trim(first.name, char(9,10,11,12,13,32)))
    ELSE 'name:' || lower(trim(first.name, char(9,10,11,12,13,32)))
  END
  FROM speaker_assets AS first
  WHERE first.version_group_id = COALESCE(speaker_assets.version_group_id, speaker_assets.id)
  ORDER BY first.version_number ASC
  LIMIT 1
)
WHERE logical_key IS NULL;

-- Rows with no group at all — written before `1402` added the column — key off themselves.
--
-- `version_group_id IS NULL` is what makes the skip above stick. Without it, a grouped row left
-- NULL because its *group's first* name is non-ASCII would be re-keyed here from its own name,
-- which breaks "one group, one key" and can hand a renamed version the key of an entirely
-- different deliverable that happens to carry the name it was renamed to.
UPDATE speaker_assets
SET logical_key = CASE
  WHEN task_id IS NOT NULL THEN 'task:' || task_id
  WHEN length(name) <> length(CAST(name AS BLOB)) THEN NULL
  WHEN session_id IS NOT NULL
    THEN 'session:' || session_id || '|name:' || lower(trim(name, char(9,10,11,12,13,32)))
  ELSE 'name:' || lower(trim(name, char(9,10,11,12,13,32)))
END
WHERE logical_key IS NULL AND version_group_id IS NULL;
