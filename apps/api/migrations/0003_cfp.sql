CREATE TABLE cfp_forms (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed')),
  version INTEGER NOT NULL CHECK (version > 0),
  published_at TEXT
);

CREATE TABLE cfp_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  cfp_version INTEGER NOT NULL CHECK (cfp_version > 0),
  idempotency_key TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE (event_id, idempotency_key)
);
CREATE INDEX cfp_submissions_event_id_idx ON cfp_submissions(event_id);
