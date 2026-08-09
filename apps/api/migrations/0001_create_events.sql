CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
