-- Itineraries first: they reference events(id), so leaving them behind makes the events
-- cleanup below fail with a foreign key violation rather than with anything that names
-- this table. A reset is also the right moment to drop them — they are attendee state
-- against a demo snapshot, and no seeded itinerary exists to restore.
DELETE FROM attendee_itineraries;
DELETE FROM public_event_projections;
