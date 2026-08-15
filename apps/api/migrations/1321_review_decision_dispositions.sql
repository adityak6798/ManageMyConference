-- Add the two programme dispositions between acceptance and decline while preserving numbered
-- decision recurrence from `1311`.
--
-- @spec PRD-REV-001

CREATE TABLE review_decisions_next (
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('accepted', 'waitlisted', 'revision_requested', 'declined')
  ),
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL,
  note TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(event_id, proposal_id)
);

INSERT INTO review_decisions_next (
  event_id, proposal_id, outcome, decided_by, decided_at, note, revision
)
SELECT event_id, proposal_id, outcome, decided_by, decided_at, note, revision
FROM review_decisions;

DROP TABLE review_decisions;
ALTER TABLE review_decisions_next RENAME TO review_decisions;
CREATE INDEX review_decisions_event_outcome_idx ON review_decisions(event_id, outcome);

INSERT OR IGNORE INTO cfp_statuses (event_id, key, label, sort_order)
SELECT id, 'waitlisted', 'Waitlist', 91 FROM events;

INSERT OR IGNORE INTO cfp_statuses (event_id, key, label, sort_order)
SELECT id, 'revision_requested', 'Request revision', 92 FROM events;
