-- @spec PRD-INT-001
-- Signed, organization-owned webhook subscriptions and their independent durable outbox.
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT REFERENCES events(id),
  url TEXT NOT NULL,
  -- Recoverable HMAC key material: outbound signing cannot use a one-way digest. This is never
  -- returned after create/rotation except when replaying that same keyed operation.
  secret_envelope TEXT NOT NULL,
  previous_secret_envelope TEXT,
  previous_secret_expires_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE webhook_subscription_event_types (
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('schedule.published')),
  PRIMARY KEY (subscription_id, event_type)
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT REFERENCES events(id),
  event_record_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('schedule.published')),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'retrying', 'succeeded', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subscription_id, idempotency_key)
);

CREATE INDEX webhook_deliveries_worker_idx
  ON webhook_deliveries(state, next_attempt_at, lease_token);
CREATE INDEX webhook_deliveries_history_idx
  ON webhook_deliveries(subscription_id, created_at, id);

CREATE TABLE webhook_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id),
  sequence INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'retryable_failure', 'terminal_failure')),
  error_code TEXT,
  -- Actor identifiers include users and API clients; issue #99 owns the unified source model.
  requested_by TEXT,
  UNIQUE (delivery_id, sequence)
);

CREATE INDEX webhook_delivery_attempts_delivery_idx
  ON webhook_delivery_attempts(delivery_id, sequence);

CREATE TABLE webhook_idempotency_records (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'disable', 'rotate', 'replay')),
  request_hash TEXT NOT NULL,
  response_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
);
