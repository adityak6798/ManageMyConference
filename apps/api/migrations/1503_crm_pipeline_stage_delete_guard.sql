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
