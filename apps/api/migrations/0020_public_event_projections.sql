CREATE TABLE IF NOT EXISTS public_event_projections (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  slug TEXT UNIQUE NOT NULL CHECK (length(slug) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'unpublished')),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  published_json TEXT CHECK (published_json IS NULL OR json_valid(published_json)),
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS public_event_projections_slug_state_idx
  ON public_event_projections(slug, state);
