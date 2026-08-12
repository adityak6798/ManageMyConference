
INSERT INTO agenda_drafts (event_id, draft_json, updated_at) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"},{"id":"track-practice","name":"Practice","color":"#16866b"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"},{"id":"slot-1000","startsAt":"2026-09-01T17:00:00.000Z","endsAt":"2026-09-01T18:00:00.000Z"}],"sessions":[],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}',
  '2026-08-10T20:00:00.000Z'
);
INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, '2026-08-10T20:00:00.000Z', 'seed-organizer',
  '{"eventId":"00000000-0000-4000-8000-000000000001","rooms":[{"id":"room-main","name":"Main stage"},{"id":"room-lab","name":"Workshop lab"}],"tracks":[{"id":"track-platform","name":"Platform","color":"#6257d9"}],"slots":[{"id":"slot-0900","startsAt":"2026-09-01T16:00:00.000Z","endsAt":"2026-09-01T17:00:00.000Z"}],"sessions":[{"id":"20000000-0000-4000-8000-000000000001","title":"Designing the calm conference","speakerIds":["10000000-0000-4000-8000-000000000001"]}],"placements":[{"id":"placement-opening","sessionId":"20000000-0000-4000-8000-000000000001","roomId":"room-main","trackId":"track-platform","slotId":"slot-0900"}]}'
);