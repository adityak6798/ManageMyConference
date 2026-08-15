-- Stable workflow keys with editable labels and closed semantic categories. A rename cannot make
-- readiness reporting forget what "ready" means.
--
-- @owner content
-- @spec PRD-SPK-001 PRD-SPK-002

CREATE TABLE content_workflow_statuses (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  category TEXT NOT NULL CHECK (category IN ('open', 'ready', 'blocked')),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, key)
);
CREATE INDEX content_workflow_statuses_event_order_idx
  ON content_workflow_statuses(event_id, sort_order, key);

INSERT INTO content_workflow_statuses
  (id, event_id, key, label, category, sort_order, created_at)
SELECT lower(hex(randomblob(16))), id, 'invited', 'Invited', 'open', 0,
       '2026-08-14T00:00:00.000Z' FROM events;
INSERT INTO content_workflow_statuses
  (id, event_id, key, label, category, sort_order, created_at)
SELECT lower(hex(randomblob(16))), id, 'onboarding', 'Onboarding', 'open', 1,
       '2026-08-14T00:00:00.000Z' FROM events;
INSERT INTO content_workflow_statuses
  (id, event_id, key, label, category, sort_order, created_at)
SELECT lower(hex(randomblob(16))), id, 'ready', 'Ready', 'ready', 2,
       '2026-08-14T00:00:00.000Z' FROM events;
INSERT INTO content_workflow_statuses
  (id, event_id, key, label, category, sort_order, created_at)
SELECT lower(hex(randomblob(16))), id, 'blocked', 'Blocked', 'blocked', 3,
       '2026-08-14T00:00:00.000Z' FROM events;

