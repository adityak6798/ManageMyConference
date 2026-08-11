CREATE TABLE agenda_drafts (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agenda_publications (
  event_id TEXT NOT NULL REFERENCES events(id),
  version INTEGER NOT NULL CHECK (version > 0),
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES users(id),
  schedule_json TEXT NOT NULL,
  PRIMARY KEY (event_id, version)
);
CREATE INDEX agenda_publications_latest_idx ON agenda_publications(event_id, version DESC);
