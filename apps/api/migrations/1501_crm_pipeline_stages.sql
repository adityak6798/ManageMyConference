-- @spec PRD-CRM-001
--
-- A configurable sourcing pipeline: named stages an organizer maintains, each mapped to a
-- semantic category that filters and automations can rely on across renames (#197).
--
-- ## Why the category is not just a label
--
-- "Won" has to survive an organizer renaming Confirmed to Locked In. A filter or a report keyed
-- on the *name* breaks the moment somebody edits it, which is the thing that makes a configurable
-- pipeline worse than a fixed one rather than better. The category is closed and the key is
-- stable; only the label is the organizer's to change freely.
--
-- ## Why this is two migrations
--
-- Storing a stage an organizer *added* also needs the CHECK that `0015` put on
-- `crm_prospects.stage` to go, and dropping a CHECK in SQLite means rebuilding the table. That
-- rebuild is `1502`, on its own, so it can be replayed over a populated database the way `1703`
-- is — a rebuild is the one migration shape whose test can be green while the migration cannot
-- run at all, and a file that also creates tables cannot be applied twice to check.

CREATE TABLE crm_pipeline_stages (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  -- Stable across renames: it is what a prospect row stores and what history refers to.
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  category TEXT NOT NULL CHECK (category IN ('open', 'won', 'nurture', 'lost')),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, key)
);
CREATE INDEX crm_pipeline_stages_event_order_idx
  ON crm_pipeline_stages (event_id, sort_order, key);

-- Every move, with who made it, when, where from, where to, and what did it.
--
-- Separate from `crm_activities` rather than another kind on it, because this is the record a
-- report reads and an activity summary is a sentence. The stage keys are stored as text rather
-- than as a foreign key into `crm_pipeline_stages`: history has to survive a stage being deleted,
-- and a reference would either block the delete or rewrite the past.
CREATE TABLE crm_prospect_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  prospect_id TEXT NOT NULL,
  -- Null for the transition that created the prospect: it came from nowhere.
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('board', 'detail', 'created', 'conversion', 'migration')),
  occurred_at TEXT NOT NULL
);
CREATE INDEX crm_prospect_transitions_timeline_idx
  ON crm_prospect_transitions (prospect_id, occurred_at);

-- The documented lifecycle, for every event that already has a pipeline. `identified` and
-- `converted` keep the keys `0015` gave them so no prospect row has to be rewritten, and
-- `converted` is `won` because reaching it is the effect of a conversion.
--
-- One statement per stage rather than one `CROSS JOIN` over a `UNION ALL` list: workerd's
-- SQLite caps the terms in a compound SELECT well below eight, and an eight-way union is
-- refused outright with `too many terms in compound SELECT`.
INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'identified',
  'Identified',
  'open',
  0,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'contacted',
  'Contacted',
  'open',
  1,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'engaged',
  'Engaged',
  'open',
  2,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'invited',
  'Invited',
  'open',
  3,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'confirmed',
  'Confirmed',
  'won',
  4,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'converted',
  'Converted',
  'won',
  5,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'future-fit',
  'Future fit',
  'nurture',
  6,
  '2026-08-14T00:00:00.000Z'
FROM events e;

INSERT INTO crm_pipeline_stages (id, event_id, key, label, category, sort_order, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  e.id,
  'declined',
  'Declined',
  'lost',
  7,
  '2026-08-14T00:00:00.000Z'
FROM events e;

-- Every prospect that already exists gets its opening transition, so a board opened after this
-- migration shows a history rather than an empty one. `migration` as the source says plainly
-- that nobody made this move — the alternative was attributing it to whoever owns the prospect,
-- which would be a false statement on the record a report reads.
INSERT INTO crm_prospect_transitions (
  id, event_id, prospect_id, from_stage, to_stage, actor_id, source, occurred_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  p.event_id,
  p.id,
  NULL,
  p.stage,
  p.owner_id,
  'migration',
  p.created_at
FROM crm_prospects p;
