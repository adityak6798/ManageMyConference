-- The first attendee-scoped data in the product.
--
-- An itinerary belongs to nobody: `/api/public/*` is anonymous by construction, and the
-- CORS policy that makes the embeds work (`Access-Control-Allow-Origin: *` without
-- credentials) means a browser would refuse to send a cookie to it anyway. The row is
-- therefore addressed by an unguessable capability token rather than by a user, and only
-- the SHA-256 of that token is stored, so a leaked database yields no working itinerary
-- URL. That is the same reason an API key is never stored in the clear.
--
-- Apostrophes are avoided in these comments on purpose: tools/check-schema-drift.mjs
-- tokenises the stored DDL without stripping comments, so one would open a string literal
-- and hide the CHECK constraints below it from the drift comparison.
CREATE TABLE IF NOT EXISTS attendee_itineraries (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  event_id TEXT NOT NULL REFERENCES events(id),
  -- The chosen sessions, named by the public slugs the projection assigned. Storage ids never
  -- appear here: the projection is the only thing this table is allowed to name, so an
  -- itinerary cannot outlive or reach past what the organizer published.
  session_slugs TEXT NOT NULL CHECK (json_valid(session_slugs)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS attendee_itineraries_event_id_idx
  ON attendee_itineraries(event_id);
