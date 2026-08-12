-- A draft public address is already reserved even while the previous published address stays
-- live. The expression index closes draft-vs-draft races; the trigger closes live-vs-draft
-- collisions across the two representations in the row.
-- Audit old rows first: the former read-then-write check could have admitted a draft address
-- matching another event's live address. There is no product-safe winner to choose, so an
-- ambiguous deployment must stop for operator repair instead of silently preserving two owners.
CREATE TABLE publication_slug_reservation_audit (
  slug TEXT PRIMARY KEY NOT NULL
);

INSERT INTO publication_slug_reservation_audit (slug)
SELECT slug FROM public_event_projections;

INSERT INTO publication_slug_reservation_audit (slug)
SELECT json_extract(draft_json, '$.event.slug')
FROM public_event_projections
WHERE json_extract(draft_json, '$.event.slug') <> slug;

DROP TABLE publication_slug_reservation_audit;

CREATE UNIQUE INDEX public_event_projections_draft_slug_idx
  ON public_event_projections(json_extract(draft_json, '$.event.slug'));

CREATE TRIGGER public_event_projections_slug_reservation_insert
BEFORE INSERT ON public_event_projections
WHEN EXISTS (
  SELECT 1 FROM public_event_projections AS existing
  WHERE existing.event_id <> NEW.event_id
    AND (
      existing.slug IN (NEW.slug, json_extract(NEW.draft_json, '$.event.slug'))
      OR json_extract(existing.draft_json, '$.event.slug')
         IN (NEW.slug, json_extract(NEW.draft_json, '$.event.slug'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'publication slug taken');
END;

CREATE TRIGGER public_event_projections_slug_reservation_update
BEFORE UPDATE OF slug, draft_json ON public_event_projections
WHEN EXISTS (
  SELECT 1 FROM public_event_projections AS existing
  WHERE existing.event_id <> NEW.event_id
    AND (
      existing.slug IN (NEW.slug, json_extract(NEW.draft_json, '$.event.slug'))
      OR json_extract(existing.draft_json, '$.event.slug')
         IN (NEW.slug, json_extract(NEW.draft_json, '$.event.slug'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'publication slug taken');
END;
