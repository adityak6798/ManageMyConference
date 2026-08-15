-- Claim a scheduled occurrence before its external delivery begins.
--
-- The final `report_runs` row stays append-only. A claim is retained after completion so the
-- uniqueness decision survives every retry; an unmatched claim is exposed as an interrupted
-- failure by the repository rather than disappearing from the operator's history.
CREATE TABLE report_run_claims (
  run_id          TEXT PRIMARY KEY NOT NULL,
  schedule_id     TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  occurrence_key  TEXT NOT NULL,
  claimed_at      TEXT NOT NULL,
  UNIQUE (schedule_id, occurrence_key)
);
CREATE INDEX report_run_claims_schedule_idx
  ON report_run_claims(schedule_id, claimed_at);
