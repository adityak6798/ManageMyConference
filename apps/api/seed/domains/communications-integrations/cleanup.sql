-- Last-sync state is product-written, not seeded, so nothing here recreates it — but it holds a
-- foreign key to `events`, and the reset deletes events. Without this line one applied Accelevents
-- sync makes every later `npm run reset` fail with FOREIGN KEY constraint failed, and the demo the
-- reset exists to restore stays broken until someone deletes the row by hand.
DELETE FROM accelevents_sync_runs;
DELETE FROM webhook_delivery_attempts;
DELETE FROM webhook_idempotency_records;
DELETE FROM webhook_deliveries;
DELETE FROM webhook_subscription_event_types;
DELETE FROM webhook_subscriptions;
DELETE FROM calendar_invite_states;
DELETE FROM outbound_projection_state;
DELETE FROM communication_attempts;
DELETE FROM communication_deliveries;
DELETE FROM message_templates;
