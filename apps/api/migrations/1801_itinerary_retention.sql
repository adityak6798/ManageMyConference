-- Empty mints are the abuse-amplifying case and have no attendee value. This partial index
-- keeps the scheduled 24-hour sweep bounded without charging populated saved plans for it.
CREATE INDEX attendee_itineraries_empty_updated_at_idx
  ON attendee_itineraries(updated_at)
  WHERE session_slugs = '[]';
