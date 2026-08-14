-- Publishing owns one active programme and an immutable history of every composition it served.
-- Source provenance lives beside the active copy so agenda/content/CFP drift is observable and a
-- missed notification can be repaired without comparing unrelated domain tables here.
ALTER TABLE public_event_projections
  ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0
  CHECK (projection_version >= 0);

ALTER TABLE public_event_projections ADD COLUMN agenda_version INTEGER;
ALTER TABLE public_event_projections ADD COLUMN agenda_published_at TEXT;
ALTER TABLE public_event_projections ADD COLUMN cfp_version INTEGER;
ALTER TABLE public_event_projections ADD COLUMN cfp_published_at TEXT;
ALTER TABLE public_event_projections ADD COLUMN content_digest TEXT;
ALTER TABLE public_event_projections
  ADD COLUMN activation_cause TEXT
  CHECK (
    activation_cause IS NULL OR activation_cause IN (
      'site-published',
      'schedule-published',
      'source-reconciled'
    )
  );

UPDATE public_event_projections
SET projection_version = 1,
    activation_cause = 'site-published'
WHERE state = 'published' AND published_json IS NOT NULL;

CREATE TABLE public_event_projection_versions (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  activated_at TEXT NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  agenda_version INTEGER,
  agenda_published_at TEXT,
  cfp_version INTEGER,
  cfp_published_at TEXT,
  content_digest TEXT,
  activation_cause TEXT NOT NULL CHECK (
    activation_cause IN ('site-published', 'schedule-published', 'source-reconciled')
  ),
  PRIMARY KEY (event_id, version)
);

INSERT INTO public_event_projection_versions (
  event_id,
  version,
  activated_at,
  projection_json,
  agenda_version,
  agenda_published_at,
  cfp_version,
  cfp_published_at,
  content_digest,
  activation_cause
)
SELECT
  event_id,
  projection_version,
  published_at,
  published_json,
  agenda_version,
  agenda_published_at,
  cfp_version,
  cfp_published_at,
  content_digest,
  activation_cause
FROM public_event_projections
WHERE state = 'published' AND published_json IS NOT NULL;

CREATE INDEX public_event_projection_versions_activated_idx
  ON public_event_projection_versions(event_id, activated_at);
