-- @spec PRD-INT-001 PORT-ACCELEVENTS
--
-- Last-sync state for the Accelevents registration import (#58), so an organizer can see whether
-- the integration has ever run, when, what it did, and how it failed — without reading a log.
--
-- One row per event, replaced by each apply. The history of *what changed* already exists and is
-- richer than anything kept here: every imported registrant is a speaker profile carrying its
-- Accelevents reference, and content's speaker-import ledger records the per-address outcome. So
-- this table answers only the question those cannot — "did the last run succeed, and when?" —
-- and keeping a run log alongside them would be a third place to disagree.
--
-- A dry run never writes here. It changes nothing by definition, and recording it would make
-- "last sync" a claim about something that did not happen.
CREATE TABLE accelevents_sync_runs (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  total INTEGER NOT NULL,
  created INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  invalid INTEGER NOT NULL,
  -- A normalized code, never a provider message: an error body can echo a token or an address
  -- back, and this column is rendered in the organizer's UI.
  error_code TEXT
);
