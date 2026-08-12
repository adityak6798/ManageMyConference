-- @spec PRD-AGD-001
--
-- Idempotency for the publish command.
--
-- Publishing allocates the next version on every call, which is right for a *deliberate*
-- republication and wrong for a retry: a client that never saw the response to its first
-- attempt would create a second immutable version of an identical board, and a second event
-- announcing it, for one intended action (issue #22).
--
-- The key is supplied by the caller and unique per event, so a repeat returns the publication
-- the first attempt committed. It is nullable because a publish without one is still valid and
-- still allocates a new version — the absence of a key means "this is a new intent", which is
-- exactly what the organizer pressing Publish a second time after editing the board means.
--
-- The unique index is partial for that reason: many publications may have no key, and NULLs
-- must not collide with each other.
ALTER TABLE agenda_publications ADD COLUMN command_key TEXT;

CREATE UNIQUE INDEX agenda_publications_command_key_idx
  ON agenda_publications(event_id, command_key)
  WHERE command_key IS NOT NULL;
