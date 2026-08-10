CREATE TABLE cfp_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  submitter_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'under_review', 'reviewed', 'withdrawn'))
);
CREATE INDEX cfp_submissions_event_status_idx ON cfp_submissions(event_id, status);

CREATE TABLE cfp_status_audit (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  occurred_at TEXT NOT NULL
);
CREATE INDEX cfp_status_audit_event_idx ON cfp_status_audit(event_id, occurred_at);

CREATE TABLE review_plans (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  criteria_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(event_id, proposal_id, reviewer_id)
);
CREATE INDEX review_assignments_reviewer_idx ON review_assignments(event_id, reviewer_id);

CREATE TABLE review_conflicts (
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  PRIMARY KEY(assignment_id, reviewer_id)
);

CREATE TABLE review_evaluations (
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  scores_json TEXT NOT NULL,
  notes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'completed')),
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(assignment_id, reviewer_id)
);

CREATE TABLE review_outcomes (
  event_id TEXT NOT NULL REFERENCES events(id),
  proposal_id TEXT NOT NULL REFERENCES cfp_submissions(id),
  completed_evaluation_count INTEGER NOT NULL,
  average_score REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, proposal_id)
);

CREATE TABLE review_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'EVT-REVIEW-COMPLETED'),
  version INTEGER NOT NULL CHECK (version = 1),
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  UNIQUE(event_type, assignment_id, version)
);
