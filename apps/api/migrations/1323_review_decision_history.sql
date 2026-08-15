-- Immutable decision occurrences. The canonical row stays one-per-proposal; this table preserves
-- accept → waitlist → accept rather than overwriting the first two facts.
-- @owner review
-- @spec PRD-REV-001 PRD-OPS-003
CREATE TABLE review_decision_history (
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  revision INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','waitlisted','revision_requested','declined')),
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY(event_id,proposal_id,revision)
);
INSERT INTO review_decision_history
SELECT event_id,proposal_id,revision,outcome,decided_by,decided_at,note FROM review_decisions;
CREATE INDEX review_decision_history_event_time_idx
  ON review_decision_history(event_id,decided_at,proposal_id,revision);
CREATE TRIGGER review_decision_history_insert
AFTER INSERT ON review_decisions
BEGIN
  INSERT INTO review_decision_history VALUES(
    NEW.event_id,NEW.proposal_id,NEW.revision,NEW.outcome,NEW.decided_by,NEW.decided_at,NEW.note
  );
END;
CREATE TRIGGER review_decision_history_change
AFTER UPDATE ON review_decisions
WHEN NEW.revision<>OLD.revision
BEGIN
  INSERT INTO review_decision_history VALUES(
    NEW.event_id,NEW.proposal_id,NEW.revision,NEW.outcome,NEW.decided_by,NEW.decided_at,NEW.note
  );
END;
