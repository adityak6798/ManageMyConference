-- The unified audit timeline: one append-only record per mutation worth remembering, from every
-- domain, in one order.
--
-- **Append-only is structural, not conventional.** The two triggers below refuse an UPDATE and a
-- DELETE outright, so a record cannot be edited or removed by any code path — a bug, a migration
-- or a hand-run statement included. An audit log that a later write can rewrite is not evidence
-- of anything, and the guard belongs where the rows are rather than in the one service that is
-- supposed to be the only writer. `1802_publication_slug_reservations.sql` is the in-repo
-- precedent for guarding a table with a trigger.
--
-- **Deliberately no foreign keys.** `organization_id`, `event_id` and `actor_id` are recorded as
-- the identifiers they were at the time and are not references. An audit record has to outlive
-- the thing it describes: a record that disappeared when its event was deleted would be missing
-- exactly when somebody most needs it, which is the opposite of what this table is for. The
-- consequence, and it is deliberate: nothing here is cleaned up by the seed reset, so records
-- accumulate across runs of the local fixture. That is what an append-only log does.
--
-- `UNIQUE(organization_id, idempotency_key)` is what makes a replayed command produce one record
-- rather than two. The key is derived from the fact rather than from the attempt, so retrying a
-- publish that already committed converges, while a genuinely new occurrence allocates a new key.
CREATE TABLE platform_audit_records (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  -- Null for a record nobody signed: the one-minute tick, a lifecycle consequence with no
  -- request behind it. `actor_name` still says what it was, so a reader is never shown a blank.
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'api', 'agent', 'system')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key)
);

-- The timeline's only read: one event, newest first, paged by (occurred_at, id).
CREATE INDEX platform_audit_records_event_occurred_idx
  ON platform_audit_records(event_id, occurred_at, id);

CREATE TRIGGER platform_audit_records_no_update
BEFORE UPDATE ON platform_audit_records
BEGIN
  SELECT RAISE(ABORT, 'platform_audit_records is append-only');
END;

CREATE TRIGGER platform_audit_records_no_delete
BEFORE DELETE ON platform_audit_records
BEGIN
  SELECT RAISE(ABORT, 'platform_audit_records is append-only');
END;
