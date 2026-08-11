CREATE TABLE content_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  format TEXT NOT NULL,
  speaker_profile_ids TEXT NOT NULL,
  tags TEXT NOT NULL,
  tracks TEXT NOT NULL,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('draft','ready','published')),
  schedule_starts_at TEXT,
  schedule_ends_at TEXT,
  schedule_location TEXT,
  UNIQUE(event_id, proposal_id)
);
CREATE TABLE speaker_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  source_person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  bio TEXT NOT NULL,
  pronouns TEXT NOT NULL,
  organization TEXT NOT NULL,
  photo_asset_id TEXT,
  UNIQUE(event_id, source_person_id)
);
CREATE TABLE speaker_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  speaker_profile_id TEXT NOT NULL REFERENCES speaker_profiles(id),
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','complete')),
  completed_at TEXT
);
CREATE TABLE speaker_assets (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  speaker_profile_id TEXT NOT NULL REFERENCES speaker_profiles(id),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','publishable')),
  uploaded_at TEXT NOT NULL
);
CREATE TABLE speaker_messages (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  speaker_profile_id TEXT NOT NULL REFERENCES speaker_profiles(id),
  subject TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX content_sessions_event_id_idx ON content_sessions(event_id);
CREATE INDEX speaker_profiles_event_user_idx ON speaker_profiles(event_id,user_id);
CREATE INDEX speaker_tasks_profile_idx ON speaker_tasks(speaker_profile_id);
CREATE INDEX speaker_assets_profile_idx ON speaker_assets(speaker_profile_id);
CREATE INDEX speaker_messages_profile_idx ON speaker_messages(speaker_profile_id);
