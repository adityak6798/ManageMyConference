-- @spec PRD-COM-001 PRD-INT-001
--
-- A delivery now carries the message it sends. Until this migration the template text was
-- stored, versioned and then discarded at enqueue: the row held `template_id` and `payload_json`
-- but nothing a provider could put in an email and nothing an organizer could read back.
--
-- Both columns are nullable because every delivery written before this migration has no rendered
-- message and inventing one would be a lie about what was sent. Projection deliveries
-- (airtable, accelevents) legitimately have none either — they carry a payload, not a message.
ALTER TABLE communication_deliveries ADD COLUMN rendered_subject TEXT;
ALTER TABLE communication_deliveries ADD COLUMN rendered_body TEXT;
