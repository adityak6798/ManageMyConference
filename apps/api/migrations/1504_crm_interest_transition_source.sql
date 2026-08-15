-- Year-round public interest is an explicit provenance, not an organizer action attributed to
-- the default owner. The row still names that owner so the existing user FK remains useful.
--
-- @spec PRD-CRM-001

CREATE TABLE crm_prospect_transitions_next (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  prospect_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (
    source IN ('board', 'detail', 'created', 'interest', 'conversion', 'migration')
  ),
  occurred_at TEXT NOT NULL
);
INSERT INTO crm_prospect_transitions_next
  (id, event_id, prospect_id, from_stage, to_stage, actor_id, source, occurred_at)
SELECT id, event_id, prospect_id, from_stage, to_stage, actor_id, source, occurred_at
FROM crm_prospect_transitions;
DROP TABLE crm_prospect_transitions;
ALTER TABLE crm_prospect_transitions_next RENAME TO crm_prospect_transitions;
CREATE INDEX crm_prospect_transitions_timeline_idx
  ON crm_prospect_transitions (prospect_id, occurred_at);
