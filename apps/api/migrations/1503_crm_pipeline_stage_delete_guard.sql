-- @owner crm
-- @spec PRD-CRM-001
-- @issue #226

-- A stage list is replaced wholesale, but cards move independently. Refuse a stage deletion
-- from the row state at commit time so a card that arrived after the service read cannot be
-- left with a key the board no longer renders. The explicit migrate-and-delete operation moves
-- matching cards earlier in its transaction, so it passes this same guard without an escape.
CREATE TRIGGER crm_pipeline_stage_no_stranded_prospects
BEFORE DELETE ON crm_pipeline_stages
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM crm_prospects
   WHERE event_id = OLD.event_id
     AND stage = OLD.key
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline stage still holds prospects');
END;

-- The inverse race matters too: a move may have read a target that a board editor deletes
-- before the move commits. Refuse that write from the same commit-time stage set, so every
-- persisted prospect stage is renderable by the board.
CREATE TRIGGER crm_prospect_stage_requires_pipeline_stage
BEFORE UPDATE OF stage ON crm_prospects
FOR EACH ROW
WHEN NEW.stage <> OLD.stage
 AND NOT EXISTS (
   SELECT 1
     FROM crm_pipeline_stages
    WHERE event_id = NEW.event_id
      AND key = NEW.stage
 )
BEGIN
  SELECT RAISE(ABORT, 'pipeline stage does not exist');
END;

-- Creation chooses the first open stage before it writes too. The same invariant therefore has
-- to cover an INSERT whose chosen entry stage disappeared after that read.
CREATE TRIGGER crm_prospect_insert_requires_pipeline_stage
BEFORE INSERT ON crm_prospects
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM crm_pipeline_stages
   WHERE event_id = NEW.event_id
     AND key = NEW.stage
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline stage does not exist');
END;
