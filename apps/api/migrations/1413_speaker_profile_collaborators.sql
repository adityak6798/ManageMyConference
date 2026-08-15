-- Named co-presenters, assistants and agencies may share one private speaker set without gaining
-- organizer access to every speaker on the event.
-- @owner content
-- @spec PRD-SPK-001 PRD-IAM-002
CREATE TABLE speaker_profile_collaborators (
  profile_id TEXT NOT NULL REFERENCES speaker_profiles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  access TEXT NOT NULL CHECK(access IN ('view','edit')),
  added_by TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY(profile_id,user_id)
);
CREATE INDEX speaker_profile_collaborators_user_idx
  ON speaker_profile_collaborators(user_id,profile_id);
