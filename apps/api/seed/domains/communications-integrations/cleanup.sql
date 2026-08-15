-- Last-sync state is product-written, not seeded, so nothing here recreates it — but it holds a
-- foreign key to `events`, and the reset deletes events. Without this line one applied Accelevents
-- sync makes every later `npm run reset` fail with FOREIGN KEY constraint failed, and the demo the
-- reset exists to restore stays broken until someone deletes the row by hand.
DELETE FROM accelevents_sync_runs
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);

-- Webhook state is organization-scoped, and the three child tables are scoped **through their own
-- parent** rather than by repeating the organization list. That is not tidiness: `webhook_deliveries`
-- and `webhook_subscription_event_types` have no organization of their own to compare, and a child
-- left behind when its parent goes is the bare `FOREIGN KEY constraint failed` this file exists to
-- prevent. Each subquery therefore names exactly the parent rows the statement below it deletes.
DELETE FROM webhook_delivery_attempts
WHERE delivery_id IN (
  SELECT id FROM webhook_deliveries
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM webhook_idempotency_records
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM webhook_deliveries
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM webhook_subscription_event_types
WHERE subscription_id IN (
  SELECT id FROM webhook_subscriptions
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM webhook_subscriptions
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);

DELETE FROM calendar_invite_states
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
DELETE FROM outbound_projection_state
WHERE event_id IN (
  SELECT id FROM events
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM communication_attempts
WHERE delivery_id IN (
  SELECT id FROM communication_deliveries
  WHERE organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
);
DELETE FROM communication_deliveries
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);

-- Templates are organization-scoped, and scoping this one matters more than it looks: migration
-- `1706` provisions the lifecycle defaults for **every** organization, so an unscoped delete
-- here would silently strip a real conference of every message it can send (issue #217) and leave
-- nothing to put them back — `data.sql` below restores the demo organization's copies only.
DELETE FROM message_templates
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
