
INSERT INTO agenda_drafts (event_id, draft_json, updated_at) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"},{"id":"track-practice","name":"Practice","color":"#16866b"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"},{"id":"slot-1000","startsAt":"2026-09-01T17:00:00.000Z","endsAt":"2026-09-01T18:00:00.000Z"}],"sessions":[],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}',
  '2026-08-10T20:00:00.000Z'
);
INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, '2026-08-10T20:00:00.000Z', 'seed-organizer',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"}],"sessions":[{"id":"20000000-0000-4000-8000-000000000001","title":"Designing the calm conference","speakerIds":["10000000-0000-4000-8000-000000000001"]}],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}'
);
-- What version 1 above places, materialized. The seed writes `agenda_publications` directly
-- rather than through `D1AgendaRepository.publish`, so nothing else would maintain this row, and
-- a reset would leave the seeded publication with no schedule in force for its one session.
INSERT INTO agenda_session_schedules (
  event_id, session_id, starts_at, ends_at, location, revision, revised_at
) VALUES (
  '00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z', 'Main stage',
  1, '2026-08-10T20:00:00.000Z'
);-- And the statement that says the row above is current.
--
-- The insert into `agenda_publications` already created this row through `1602`'s trigger, with
-- `materialized_watermark` NULL — the seed is precisely one of the direct writers that motivated
-- the trigger, and the trigger cannot tell that this one does maintain the derived table. Claiming
-- the watermark here is what makes the seeded event *sound* rather than merely correct: without it
-- every fixture starts life flagged as drifted, and the first read of the demo schedule would
-- replay a one-publication history to rediscover the row three lines above (issue #169).
INSERT INTO agenda_schedule_materializations (
  event_id, publication_watermark, materialized_watermark, materialized_at
) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, 1, '2026-08-10T20:00:00.000Z'
)
ON CONFLICT(event_id) DO UPDATE SET
  materialized_watermark = excluded.materialized_watermark,
  materialized_at = excluded.materialized_at;
