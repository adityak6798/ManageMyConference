CREATE TABLE speaker_resources (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  body_html TEXT NOT NULL,
  embed_html TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('hidden','visible')),
  sort_order INTEGER NOT NULL,
  UNIQUE(event_id, slug)
);
CREATE INDEX speaker_resources_event_order_idx ON speaker_resources(event_id, sort_order);
