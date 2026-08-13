/** D1 storage for the communications-integrations webhook outbox. @spec PRD-INT-001 */
import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookEventType,
  WebhookSubscription,
} from "../../domain/communications/webhook";
import type {
  WebhookIdempotencyWrite,
  WebhookRepository,
} from "../../application/communications/webhooks";
import { changedRows, type D1WriteResult } from "./d1-write-result";
import type { WebhookSecretProtector } from "../../application/communications/webhook-security";

interface Statement {
  bind(...values: unknown[]): Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
export interface WebhookDatabasePort {
  prepare(query: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface SubscriptionRow {
  id: string;
  organization_id: string;
  event_id: string | null;
  url: string;
  secret_envelope: string;
  previous_secret_envelope: string | null;
  previous_secret_expires_at: string | null;
  state: "active" | "disabled";
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  revision: number;
}
interface DeliveryRow {
  id: string;
  subscription_id: string;
  organization_id: string;
  event_id: string | null;
  event_record_id: string;
  event_type: WebhookEventType;
  idempotency_key: string;
  payload_json: string;
  state: WebhookDelivery["state"];
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
}
interface AttemptRow {
  id: string;
  delivery_id: string;
  sequence: number;
  started_at: string;
  completed_at: string;
  outcome: WebhookDeliveryAttempt["outcome"];
  error_code: string | null;
  requested_by: string | null;
}

const subscriptionColumns =
  "id, organization_id, event_id, url, secret_envelope, previous_secret_envelope, previous_secret_expires_at, state, created_at, disabled_at, disabled_reason, revision";
const deliveryColumns =
  "id, subscription_id, organization_id, event_id, event_record_id, event_type, idempotency_key, payload_json, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at";
const hydrateDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  subscriptionId: row.subscription_id,
  organizationId: row.organization_id,
  eventId: row.event_id,
  eventRecordId: row.event_record_id,
  eventType: row.event_type,
  idempotencyKey: row.idempotency_key,
  payload: JSON.parse(row.payload_json),
  state: row.state,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  leaseToken: row.lease_token,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const hydrateAttempt = (row: AttemptRow): WebhookDeliveryAttempt => ({
  id: row.id,
  deliveryId: row.delivery_id,
  sequence: row.sequence,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  outcome: row.outcome,
  errorCode: row.error_code,
  requestedBy: row.requested_by,
});

export class D1WebhookRepository implements WebhookRepository {
  constructor(
    private readonly database: WebhookDatabasePort,
    private readonly secrets: WebhookSecretProtector,
  ) {}
  private read(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
  }
  private writes(results: readonly D1WriteResult[], operation: string) {
    if (results.some((result) => !result.success)) throw new Error(`D1 failed to ${operation}`);
  }
  async idempotencyRecord(organizationId: string, idempotencyKey: string) {
    const result = await this.database
      .prepare(
        "SELECT operation, request_hash, response_envelope FROM webhook_idempotency_records WHERE organization_id = ? AND idempotency_key = ?",
      )
      .bind(organizationId, idempotencyKey)
      .all<{ operation: string; request_hash: string; response_envelope: string }>();
    this.read(result, "load webhook idempotency record");
    const row = result.results?.[0];
    return row
      ? {
          operation: row.operation,
          requestHash: row.request_hash,
          response: JSON.parse(
            await this.secrets.open(
              row.response_envelope,
              `webhook-idempotency:${organizationId}:${idempotencyKey}`,
            ),
          ),
        }
      : null;
  }
  private async idempotencyStatement(input: WebhookIdempotencyWrite) {
    const responseEnvelope = await this.secrets.seal(
      JSON.stringify(input.response),
      `webhook-idempotency:${input.organizationId}:${input.idempotencyKey}`,
    );
    return this.database
      .prepare(
        "INSERT INTO webhook_idempotency_records (organization_id, idempotency_key, operation, request_hash, response_envelope, created_at) SELECT ?,?,?,?,?,? WHERE changes() > 0",
      )
      .bind(
        input.organizationId,
        input.idempotencyKey,
        input.operation,
        input.requestHash,
        responseEnvelope,
        input.createdAt,
      );
  }
  private async hydrate(row: SubscriptionRow): Promise<WebhookSubscription> {
    const types = await this.database
      .prepare(
        "SELECT event_type FROM webhook_subscription_event_types WHERE subscription_id = ? ORDER BY event_type",
      )
      .bind(row.id)
      .all<{ event_type: WebhookEventType }>();
    this.read(types, "load webhook event types");
    return {
      id: row.id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      url: row.url,
      secretMaterial: await this.secrets.open(
        row.secret_envelope,
        `webhook-subscription:${row.organization_id}:${row.id}:current`,
      ),
      previousSecretMaterial: row.previous_secret_envelope
        ? await this.secrets.open(
            row.previous_secret_envelope,
            `webhook-subscription:${row.organization_id}:${row.id}:previous`,
          )
        : null,
      previousSecretExpiresAt: row.previous_secret_expires_at,
      eventTypes: (types.results ?? []).map(({ event_type }) => event_type),
      state: row.state,
      createdAt: row.created_at,
      disabledAt: row.disabled_at,
      disabledReason: row.disabled_reason,
      revision: row.revision,
    };
  }
  async create(
    subscription: WebhookSubscription,
    idempotency: WebhookIdempotencyWrite,
  ): Promise<void> {
    const secretEnvelope = await this.secrets.seal(
      subscription.secretMaterial,
      `webhook-subscription:${subscription.organizationId}:${subscription.id}:current`,
    );
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO webhook_subscriptions (id, organization_id, event_id, url, secret_envelope, previous_secret_envelope, previous_secret_expires_at, state, created_at, disabled_at, disabled_reason, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          subscription.id,
          subscription.organizationId,
          subscription.eventId,
          subscription.url,
          secretEnvelope,
          null,
          null,
          subscription.state,
          subscription.createdAt,
          null,
          null,
          0,
        ),
      this.database
        .prepare(
          "INSERT INTO webhook_subscription_event_types (subscription_id, event_type) SELECT ?, value FROM json_each(?)",
        )
        .bind(subscription.id, JSON.stringify(subscription.eventTypes)),
      await this.idempotencyStatement(idempotency),
    ]);
    this.writes(results, "create a webhook subscription");
  }
  async list(organizationId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM webhook_subscriptions WHERE organization_id = ? ORDER BY created_at DESC, id`,
      )
      .bind(organizationId)
      .all<SubscriptionRow>();
    this.read(result, "list webhook subscriptions");
    return Promise.all((result.results ?? []).map((row) => this.hydrate(row)));
  }
  async get(subscriptionId: string) {
    const result = await this.database
      .prepare(`SELECT ${subscriptionColumns} FROM webhook_subscriptions WHERE id = ? LIMIT 1`)
      .bind(subscriptionId)
      .all<SubscriptionRow>();
    this.read(result, "get a webhook subscription");
    return result.results?.[0] ? this.hydrate(result.results[0]) : null;
  }
  async update(
    input: {
      organizationId: string;
      subscriptionId: string;
      expectedRevision: number;
      url?: string;
      eventId?: string | null;
      eventTypes?: readonly WebhookEventType[];
    },
    idempotency: WebhookIdempotencyWrite,
  ): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE webhook_subscriptions SET url = CASE WHEN ? THEN ? ELSE url END, event_id = CASE WHEN ? THEN ? ELSE event_id END, revision = revision + 1 WHERE id = ? AND organization_id = ? AND state = 'active' AND revision = ?",
        )
        .bind(
          input.url !== undefined ? 1 : 0,
          input.url ?? null,
          input.eventId !== undefined ? 1 : 0,
          input.eventId ?? null,
          input.subscriptionId,
          input.organizationId,
          input.expectedRevision,
        ),
      ...(input.eventTypes
        ? [
            this.database
              .prepare(
                "DELETE FROM webhook_subscription_event_types WHERE subscription_id = ? AND changes() > 0",
              )
              .bind(input.subscriptionId),
            this.database
              .prepare(
                "INSERT INTO webhook_subscription_event_types (subscription_id, event_type) SELECT ?, value FROM json_each(?) WHERE changes() > 0",
              )
              .bind(input.subscriptionId, JSON.stringify(input.eventTypes)),
          ]
        : []),
      await this.idempotencyStatement(idempotency),
    ]);
    this.writes(results, "update a webhook subscription");
    const write = results[0];
    if (!write) throw new Error("D1 returned no webhook update result");
    return changedRows(write, "update a webhook subscription");
  }
  async disable(
    organizationId: string,
    subscriptionId: string,
    now: string,
    reason: string,
    idempotency: WebhookIdempotencyWrite,
  ) {
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE webhook_subscriptions SET state = 'disabled', disabled_at = ?, disabled_reason = ? WHERE id = ? AND organization_id = ? AND state = 'active'",
        )
        .bind(now, reason, subscriptionId, organizationId),
      await this.idempotencyStatement(idempotency),
    ]);
    this.writes(results, "disable a webhook subscription");
    const result = results[0];
    if (!result) throw new Error("D1 returned no webhook disable result");
    return changedRows(result, "disable a webhook subscription");
  }
  async rotate(
    organizationId: string,
    subscriptionId: string,
    secretMaterial: string,
    overlapExpiresAt: string,
    expectedRevision: number,
    idempotency: WebhookIdempotencyWrite,
  ) {
    const current = await this.get(subscriptionId);
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.state !== "active" ||
      current.revision !== expectedRevision
    )
      return 0;
    const previousEnvelope = await this.secrets.seal(
      current.secretMaterial,
      `webhook-subscription:${organizationId}:${subscriptionId}:previous`,
    );
    const secretEnvelope = await this.secrets.seal(
      secretMaterial,
      `webhook-subscription:${organizationId}:${subscriptionId}:current`,
    );
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE webhook_subscriptions SET previous_secret_envelope = ?, previous_secret_expires_at = ?, secret_envelope = ?, revision = revision + 1 WHERE id = ? AND organization_id = ? AND state = 'active' AND revision = ?",
        )
        .bind(
          previousEnvelope,
          overlapExpiresAt,
          secretEnvelope,
          subscriptionId,
          organizationId,
          expectedRevision,
        ),
      await this.idempotencyStatement(idempotency),
    ]);
    this.writes(results, "rotate a webhook secret");
    const result = results[0];
    if (!result) throw new Error("D1 returned no webhook rotation result");
    return changedRows(result, "rotate a webhook secret");
  }
  async activeFor(eventType: WebhookEventType, organizationId: string, eventId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM webhook_subscriptions WHERE organization_id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM webhook_subscription_event_types t WHERE t.subscription_id = webhook_subscriptions.id AND t.event_type = ?) AND (event_id IS NULL OR event_id = ?) ORDER BY id`,
      )
      .bind(organizationId, eventType, eventId)
      .all<SubscriptionRow>();
    this.read(result, "find active webhook subscriptions");
    return Promise.all((result.results ?? []).map((row) => this.hydrate(row)));
  }
  async enqueue(delivery: WebhookDelivery) {
    const insert = await this.database
      .prepare(
        "INSERT OR IGNORE INTO webhook_deliveries (id, subscription_id, organization_id, event_id, event_record_id, event_type, idempotency_key, payload_json, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        delivery.id,
        delivery.subscriptionId,
        delivery.organizationId,
        delivery.eventId,
        delivery.eventRecordId,
        delivery.eventType,
        delivery.idempotencyKey,
        JSON.stringify(delivery.payload),
        delivery.state,
        delivery.attemptCount,
        delivery.nextAttemptAt,
        null,
        delivery.createdAt,
        delivery.updatedAt,
      )
      .run();
    this.read(insert, "enqueue a webhook delivery");
    const found = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM webhook_deliveries WHERE subscription_id = ? AND idempotency_key = ?`,
      )
      .bind(delivery.subscriptionId, delivery.idempotencyKey)
      .all<DeliveryRow>();
    this.read(found, "reload a webhook delivery");
    const row = found.results?.[0];
    if (!row) throw new Error("D1 did not return enqueued webhook delivery");
    return hydrateDelivery(row);
  }
  async getDelivery(deliveryId: string) {
    const result = await this.database
      .prepare(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE id = ?`)
      .bind(deliveryId)
      .all<DeliveryRow>();
    this.read(result, "get a webhook delivery");
    return result.results?.[0] ? hydrateDelivery(result.results[0]) : null;
  }
  async historyPage(
    subscriptionId: string,
    page: { limit: number; after?: { createdAt: string; id: string } },
  ) {
    const clause = page.after ? " AND (created_at > ? OR (created_at = ? AND id > ?))" : "";
    const result = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM webhook_deliveries WHERE subscription_id = ?${clause} ORDER BY created_at, id LIMIT ?`,
      )
      .bind(
        subscriptionId,
        ...(page.after ? [page.after.createdAt, page.after.createdAt, page.after.id] : []),
        page.limit + 1,
      )
      .all<DeliveryRow>();
    this.read(result, "load webhook history");
    const deliveries = (result.results ?? []).slice(0, page.limit).map(hydrateDelivery);
    if (!deliveries.length) return { items: [], hasMore: false };
    const attempts = await this.database
      .prepare(
        `SELECT id, delivery_id, sequence, started_at, completed_at, outcome, error_code, requested_by FROM webhook_delivery_attempts WHERE delivery_id IN (${deliveries.map(() => "?").join(",")}) ORDER BY delivery_id, sequence`,
      )
      .bind(...deliveries.map(({ id }) => id))
      .all<AttemptRow>();
    this.read(attempts, "load webhook attempts");
    const grouped = new Map<string, WebhookDeliveryAttempt[]>();
    for (const row of attempts.results ?? [])
      grouped.set(row.delivery_id, [...(grouped.get(row.delivery_id) ?? []), hydrateAttempt(row)]);
    return {
      items: deliveries.map((delivery) => ({ delivery, attempts: grouped.get(delivery.id) ?? [] })),
      hasMore: (result.results?.length ?? 0) > page.limit,
    };
  }
  async leaseNext(now: string, leaseToken: string) {
    const stale = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const claimed = await this.database
      .prepare(
        "UPDATE webhook_deliveries SET lease_token = ?, updated_at = ? WHERE id = (SELECT id FROM webhook_deliveries WHERE state IN ('queued','retrying') AND next_attempt_at <= ? AND (lease_token IS NULL OR updated_at <= ?) ORDER BY next_attempt_at, created_at LIMIT 1) AND (lease_token IS NULL OR updated_at <= ?)",
      )
      .bind(leaseToken, now, now, stale, stale)
      .run();
    this.read(claimed, "lease a webhook delivery");
    const result = await this.database
      .prepare(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE lease_token = ?`)
      .bind(leaseToken)
      .all<DeliveryRow>();
    this.read(result, "load a webhook lease");
    return result.results?.[0] ? hydrateDelivery(result.results[0]) : null;
  }
  async complete(
    leaseToken: string,
    attempt: WebhookDeliveryAttempt,
    next: Pick<WebhookDelivery, "state" | "nextAttemptAt" | "updatedAt">,
  ) {
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE webhook_deliveries SET state = ?, attempt_count = ?, next_attempt_at = ?, lease_token = NULL, updated_at = ? WHERE id = ? AND lease_token = ?",
        )
        .bind(
          next.state,
          attempt.sequence,
          next.nextAttemptAt,
          next.updatedAt,
          attempt.deliveryId,
          leaseToken,
        ),
      this.database
        .prepare(
          "INSERT INTO webhook_delivery_attempts (id, delivery_id, sequence, started_at, completed_at, outcome, error_code, requested_by) SELECT ?,?,?,?,?,?,?,? WHERE changes() > 0",
        )
        .bind(
          attempt.id,
          attempt.deliveryId,
          attempt.sequence,
          attempt.startedAt,
          attempt.completedAt,
          attempt.outcome,
          attempt.errorCode,
          attempt.requestedBy,
        ),
    ]);
    this.writes(results, "complete a webhook attempt");
    const update = results[0];
    if (!update || changedRows(update, "complete a webhook attempt") !== 1)
      throw new Error("Webhook lease was lost before completion");
  }
  async replay(
    deliveryId: string,
    organizationId: string,
    actorId: string,
    now: string,
    attemptId: string,
    idempotency: WebhookIdempotencyWrite,
  ) {
    const delivery = await this.getDelivery(deliveryId);
    if (!delivery || delivery.organizationId !== organizationId || delivery.leaseToken) return 0;
    const sequence = delivery.attemptCount + 1;
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE webhook_deliveries SET state = 'queued', attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND lease_token IS NULL",
        )
        .bind(sequence, now, now, deliveryId, organizationId),
      this.database
        .prepare(
          "INSERT INTO webhook_delivery_attempts (id, delivery_id, sequence, started_at, completed_at, outcome, error_code, requested_by) SELECT ?,?,?,?,?,'retryable_failure','MANUAL_REPLAY_REQUESTED',? WHERE changes() > 0",
        )
        .bind(attemptId, deliveryId, sequence, now, now, actorId),
      await this.idempotencyStatement(idempotency),
    ]);
    this.writes(results, "replay a webhook delivery");
    const update = results[0];
    if (!update) throw new Error("D1 returned no webhook replay result");
    return changedRows(update, "replay a webhook delivery");
  }
}
