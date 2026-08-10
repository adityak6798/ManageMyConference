-- Content-owned projection implementing the declared speaker conversion port.
CREATE TABLE speaker_profiles (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, email TEXT NOT NULL);
CREATE UNIQUE INDEX speaker_profiles_event_email_idx ON speaker_profiles(event_id, email);
CREATE TABLE speaker_conversion_sources (event_id TEXT NOT NULL REFERENCES events(id), source_kind TEXT NOT NULL, source_id TEXT NOT NULL, speaker_id TEXT NOT NULL REFERENCES speaker_profiles(id), PRIMARY KEY(event_id, source_kind, source_id));
