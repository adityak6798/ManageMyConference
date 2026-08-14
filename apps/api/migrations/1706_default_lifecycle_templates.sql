-- @spec PRD-COM-001
--
-- Give every organization that already exists the eleven lifecycle templates (issues #217, #210).
--
-- ## What was wrong
--
-- Every lifecycle message resolves a `message_templates` row scoped to the **organization**, and
-- no migration had ever inserted one. The only rows anywhere came from
-- `apps/api/seed/domains/communications-integrations/data.sql`, all for organization
-- `00000000-0000-4000-8000-000000000010`. For every other organization — every self-serve Google
-- signup, and every organization on a deployment nobody seeded — `CommunicationsService.prepare`
-- threw `Template version not found`, `notifyLifecycle` swallowed it as it is designed to, the
-- lifecycle action succeeded, and no delivery row was ever written. Nine triggers, invisibly.
--
-- The deployed database already holds at least one self-serve organization, from the first real
-- Google sign-in (issue #216). This is the backfill that requirement asks for: it runs once, and
-- afterwards every organization in the database holds the same nine version-1 rows the demo does.
--
-- ## Why this is a backfill and not the whole fix
--
-- An organization created *after* this migration runs would still have none, so
-- `CommunicationsService` provisions the same catalogue on resolution and on the organizer's
-- template list. All three routes write version 1 of the same nine keys and
-- `(organization_id, template_key, version)` is unique, so they converge rather than collide.
-- `apps/api/src/domain/communications/default-templates.ts` is the catalogue and holds the
-- reasoning; `default-templates.integration.test.ts` asserts this file and that one agree, so the
-- two copies of these words cannot drift apart.
--
-- ## Why `NOT EXISTS` is on (organization, key) and not on (organization, key, version)
--
-- The demo organization already holds version 1 of all nine under different ids
-- (`template-speaker-v1` and friends), and an organization that has customized a message holds
-- its own version 1 or 2. Either way the key is present and nothing here should touch it: the
-- guard is "does this organization have this template at all", so this migration adds a message
-- where there was none and never overwrites, duplicates or reverts one somebody wrote.
--
-- The `1706-` id prefix makes a provisioned default recognizable in the database without joining,
-- and keeps it distinct from both the seed's ids and the UUIDs the service mints.
--
-- ## Why one statement per template rather than one cross join
--
-- The obvious form is one `INSERT … SELECT` over `organizations` cross-joined to the defaults as
-- a `SELECT … UNION ALL …` subquery. D1 refuses it: `too many terms in compound SELECT:
-- SQLITE_ERROR`, because workerd's SQLite is built with a far smaller `SQLITE_MAX_COMPOUND_SELECT`
-- than the default. Independent statements are what it accepts, and each carries its own
-- `NOT EXISTS` guard, so a partially provisioned organization is filled in per key rather than
-- all-or-nothing.
--
-- ## The last two are issue #210's, and they arrive here rather than in their own migration
--
-- `cfp-deadline-reminder` and `cfp-call-closed` are the scheduled deadline messages. They belong
-- to the same catalogue and to the same lane as the nine above, and splitting them into a second
-- backfill would mean two migrations doing one thing with the same guard. Migration `1707` widens
-- `communication_deliveries.trigger_type` so the deliveries they render can be written at all.

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-speaker-invite',
  o.id,
  'speaker-invite',
  1,
  'email',
  'Welcome to Greenroom',
  'Hello {{speakerName}}, your session is confirmed. Please complete your speaker profile before the event.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'speaker-invite'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-speaker-task',
  o.id,
  'speaker-task',
  1,
  'email',
  'A new task is waiting for you',
  'Hello {{speakerName}}, please complete "{{taskTitle}}" by {{dueAt}}. You can do it from your speaker portal.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'speaker-task'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-speaker-task-reminder',
  o.id,
  'speaker-task-reminder',
  1,
  'email',
  'Reminder: {{taskTitle}}',
  'Hello {{speakerName}}, "{{taskTitle}}" is due {{dueAt}} and is still open. You can complete it from your speaker portal.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'speaker-task-reminder'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-schedule-published',
  o.id,
  'schedule-published',
  1,
  'email',
  'The schedule is published',
  'Hello {{speakerName}}, the schedule is published and your session has a time. Add it to your calendar: {{calendarUrl}}',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'schedule-published'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-reviewer-assignment',
  o.id,
  'reviewer-assignment',
  1,
  'email',
  'Abstracts are waiting for your review',
  'Hello {{reviewerName}}, abstracts have been assigned to you for round {{round}}. Open your review queue when you have time.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'reviewer-assignment'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-decision-accepted',
  o.id,
  'decision-accepted',
  1,
  'email',
  'Your proposal was accepted',
  'Hello {{submitterName}}, we are delighted to tell you that "{{proposalTitle}}" has been accepted. We will be in touch with next steps shortly.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'decision-accepted'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-decision-declined',
  o.id,
  'decision-declined',
  1,
  'email',
  'About your proposal',
  'Hello {{submitterName}}, thank you for submitting "{{proposalTitle}}". We had more strong proposals than slots this year and will not be able to programme it. We hope you will submit again.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'decision-declined'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-speaker-calendar-invite',
  o.id,
  'speaker-calendar-invite',
  1,
  'email',
  'Your session at {{eventName}}',
  'Hello {{speakerName}}, here is the calendar invitation for {{sessionTitle}} at {{eventName}}. Accept it to add the session to your calendar; if the time changes we will send an update that replaces this entry.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'speaker-calendar-invite'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-proposal-submitted',
  o.id,
  'proposal-submitted',
  1,
  'email',
  'We have your proposal',
  'Hello {{submitterName}}, thank you — "{{proposalTitle}}" is with the programme team. You can read or revise it from your proposals page while the call is open, and its decision will appear there.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'proposal-submitted'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-cfp-deadline-reminder',
  o.id,
  'cfp-deadline-reminder',
  1,
  'email',
  'Your draft for {{eventName}} is not submitted yet',
  'Hello {{submitterName}}, the call for proposals for {{eventName}} closes {{closesAt}} and you still have {{draftCount}} unsubmitted on your proposals page. Open it and press Submit if you want it considered; if you have changed your mind, nothing else is needed and we will not write about it again.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'cfp-deadline-reminder'
);

INSERT INTO message_templates (
  id, organization_id, template_key, version, channel, subject, body, created_at
)
SELECT
  '1706-' || o.id || '-cfp-call-closed',
  o.id,
  'cfp-call-closed',
  1,
  'email',
  'Your call for proposals has closed',
  'Hello {{organizerName}}, the call for proposals for {{eventName}} closed {{closesAt}} and is no longer taking submissions. The proposals you received are waiting in the review queue.',
  '2026-08-14T00:00:00.000Z'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates existing
  WHERE existing.organization_id = o.id AND existing.template_key = 'cfp-call-closed'
);
