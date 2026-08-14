-- @owner events
-- @spec PRD-EVT-001
-- @issue #225

-- A retry must replay the event as creation originally answered it, even if its settings were
-- edited later. These are null for unkeyed legacy creates and populated for every keyed create.
ALTER TABLE events ADD COLUMN provisioning_name TEXT;
ALTER TABLE events ADD COLUMN provisioning_timezone TEXT;

UPDATE events
   SET provisioning_name = name,
       provisioning_timezone = timezone
 WHERE provisioning_key IS NOT NULL;
