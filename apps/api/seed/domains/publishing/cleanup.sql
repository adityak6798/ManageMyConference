-- Itineraries first: they reference events(id), so leaving them behind makes the events
-- cleanup below fail with a foreign key violation rather than with anything that names
-- this table. A reset is also the right moment to drop them — they are attendee state
-- against a demo snapshot, and no seeded itinerary exists to restore.
--
-- Scoped to the seeded events, which is the whole point of the scoping pass: an itinerary an
-- attendee built against a *real* conference sharing this deployment is not demo state and is not
-- the reset's to destroy. The reasoning above holds exactly as far as the demo's own events.
DELETE FROM attendee_itineraries
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
DELETE FROM public_event_projections
WHERE event_id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000099'
);
