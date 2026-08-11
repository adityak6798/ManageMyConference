-- A session has no time of its own: it has a placement on the agenda.
--
-- schedule_starts_at, schedule_ends_at and schedule_location were written by exactly one thing
-- in the whole repository, the demo seed. No product path ever set them and no product path
-- ever updated them, so the speaker portal and the .ics export answered from a column the
-- agenda board could not reach: a speaker was served 15 September for a session the published
-- schedule placed on 1 September, and moving that session on the board changed nothing.
--
-- They are dropped rather than kept and backfilled because a second copy of a fact is exactly
-- what produced the divergence. The one answer now comes from the agenda publication in force,
-- through AgendaService.publishedSessionSchedules, resolved on every read.
ALTER TABLE content_sessions DROP COLUMN schedule_starts_at;
ALTER TABLE content_sessions DROP COLUMN schedule_ends_at;
ALTER TABLE content_sessions DROP COLUMN schedule_location;
