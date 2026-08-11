CREATE TABLE review_decisions (
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'declined')),
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY(event_id, proposal_id)
);
CREATE INDEX review_decisions_event_outcome_idx ON review_decisions(event_id, outcome);

INSERT OR IGNORE INTO cfp_statuses (event_id, key, label, sort_order)
SELECT event_id, 'accepted', 'Accepted', 90 FROM (SELECT DISTINCT event_id FROM cfp_statuses);

INSERT OR IGNORE INTO cfp_statuses (event_id, key, label, sort_order)
SELECT event_id, 'declined', 'Declined', 91 FROM (SELECT DISTINCT event_id FROM cfp_statuses);
