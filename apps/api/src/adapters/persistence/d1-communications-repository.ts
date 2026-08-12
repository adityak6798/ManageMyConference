import {
  type CommunicationsRepository,
  DeliveryRecoveryConflictError,
} from "../../application/communications/ports";
import type { PreparedDeliveryWriter } from "../../application/communications/public";
import type {
  Delivery,
  DeliveryAttempt,
  MessageTemplate,
  ProjectionState,
} from "../../domain/communications/delivery";
interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{ success: boolean; error?: string; meta?: { changes?: number } }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
type Database = {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<{ success: boolean; error?: string }[]>;
};
type TemplateRow = {
  id: string;
  organization_id: string;
  template_key: string;
  version: number;
  channel: MessageTemplate["channel"];
  subject: string | null;
  body: string;
  created_at: string;
};
type DeliveryRow = {
  id: string;
  organization_id: string;
  event_id: string;
  idempotency_key: string;
  trigger_type: Delivery["triggerType"];
  channel: Delivery["channel"];
  template_id: string | null;
  template_version: number | null;
  recipient_ref: string;
  payload_json: string;
  rendered_subject: string | null;
  rendered_body: string | null;
  projection_version: number | null;
  state: Delivery["state"];
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
};
type AttemptRow = {
  id: string;
  delivery_id: string;
  sequence: number;
  started_at: string;
  completed_at: string;
  outcome: DeliveryAttempt["outcome"];
  provider_reference: string | null;
  error_code: string | null;
};

const deliveryColumns =
  "id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, rendered_subject, rendered_body, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at";
const deliveryFromRow = (row: DeliveryRow): Delivery => ({
  id: row.id,
  organizationId: row.organization_id,
  eventId: row.event_id,
  idempotencyKey: row.idempotency_key,
  triggerType: row.trigger_type,
  channel: row.channel,
  templateId: row.template_id,
  templateVersion: row.template_version,
  recipientRef: row.recipient_ref,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  renderedSubject: row.rendered_subject,
  renderedBody: row.rendered_body,
  projectionVersion: row.projection_version,
  state: row.state,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  leaseToken: row.lease_token,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const templateFromRow = (row: TemplateRow): MessageTemplate => ({
  id: row.id,
  organizationId: row.organization_id,
  key: row.template_key,
  version: row.version,
  channel: row.channel,
  subject: row.subject,
  body: row.body,
  createdAt: row.created_at,
});
const attemptFromRow = (row: AttemptRow): DeliveryAttempt => ({
  id: row.id,
  deliveryId: row.delivery_id,
  sequence: row.sequence,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  outcome: row.outcome,
  providerReference: row.provider_reference,
  errorCode: row.error_code,
});

const insertDeliveryStatement = (database: Database, delivery: Delivery): Statement =>
  database
    .prepare(
      `INSERT OR IGNORE INTO communication_deliveries (${deliveryColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      delivery.id,
      delivery.organizationId,
      delivery.eventId,
      delivery.idempotencyKey,
      delivery.triggerType,
      delivery.channel,
      delivery.templateId,
      delivery.templateVersion,
      delivery.recipientRef,
      JSON.stringify(delivery.payload),
      delivery.renderedSubject,
      delivery.renderedBody,
      delivery.projectionVersion,
      delivery.state,
      delivery.attemptCount,
      delivery.nextAttemptAt,
      delivery.leaseToken,
      delivery.createdAt,
      delivery.updatedAt,
    );

/**
 * The writer another domain uses to commit a delivery inside its own batch.
 *
 * The composition root binds it to the database and hands the bound function to the domain that
 * needs it, so that domain never imports this module, never names a communications column, and
 * cannot write a row this repository would not have written. `INSERT OR IGNORE` on the
 * organization-scoped idempotency key keeps a retried command converging on one delivery.
 *
 * @spec PRD-COM-001 ARC-FLOW-002
 */
export const preparedDeliveryWriter =
  (database: Database): PreparedDeliveryWriter<Statement> =>
  (prepared) => [insertDeliveryStatement(database, prepared)];

export class D1CommunicationsRepository implements CommunicationsRepository {
  constructor(private readonly database: Database) {}
  private ensure(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
  }
  async createTemplate(template: MessageTemplate) {
    const result = await this.database
      .prepare(
        "INSERT INTO message_templates (id, organization_id, template_key, version, channel, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        template.id,
        template.organizationId,
        template.key,
        template.version,
        template.channel,
        template.subject,
        template.body,
        template.createdAt,
      )
      .run();
    this.ensure(result, "create template");
  }
  async findTemplate(organizationId: string, key: string, version?: number) {
    const result = await this.database
      .prepare(
        `SELECT id, organization_id, template_key, version, channel, subject, body, created_at FROM message_templates WHERE organization_id = ? AND template_key = ?${version === undefined ? "" : " AND version = ?"} ORDER BY version DESC LIMIT 1`,
      )
      .bind(organizationId, key, ...(version === undefined ? [] : [version]))
      .all<TemplateRow>();
    this.ensure(result, "find template");
    return result.results?.[0] ? templateFromRow(result.results[0]) : null;
  }
  async enqueue(delivery: Delivery) {
    const insert = await insertDeliveryStatement(this.database, delivery).run();
    this.ensure(insert, "enqueue delivery");
    const result = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM communication_deliveries WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(delivery.organizationId, delivery.idempotencyKey)
      .all<DeliveryRow>();
    this.ensure(result, "reload delivery");
    const row = result.results?.[0];
    if (!row) throw new Error("D1 did not return enqueued delivery");
    return deliveryFromRow(row);
  }
  async list(organizationId: string, eventId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM communication_deliveries WHERE organization_id = ? AND event_id = ? ORDER BY created_at`,
      )
      .bind(organizationId, eventId)
      .all<DeliveryRow>();
    this.ensure(result, "list deliveries");
    return (result.results ?? []).map(deliveryFromRow);
  }
  async historyPage(
    organizationId: string,
    eventId: string,
    page: { limit: number; after?: { createdAt: string; id: string } },
  ) {
    const cursorClause = page.after ? " AND (created_at > ? OR (created_at = ? AND id > ?))" : "";
    const deliveriesResult = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM communication_deliveries WHERE organization_id = ? AND event_id = ?${cursorClause} ORDER BY created_at, id LIMIT ?`,
      )
      .bind(
        organizationId,
        eventId,
        ...(page.after ? [page.after.createdAt, page.after.createdAt, page.after.id] : []),
        page.limit + 1,
      )
      .all<DeliveryRow>();
    this.ensure(deliveriesResult, "load delivery history page");
    const deliveries = (deliveriesResult.results ?? []).slice(0, page.limit).map(deliveryFromRow);
    if (deliveries.length === 0) return { items: [], hasMore: false };
    const attemptsResult = await this.database
      .prepare(
        `SELECT id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code FROM communication_attempts WHERE delivery_id IN (${deliveries.map(() => "?").join(", ")}) ORDER BY delivery_id, sequence`,
      )
      .bind(...deliveries.map(({ id }) => id))
      .all<AttemptRow>();
    this.ensure(attemptsResult, "load delivery history attempts");
    const attemptsByDelivery = new Map<string, DeliveryAttempt[]>();
    for (const row of attemptsResult.results ?? []) {
      const attempt = attemptFromRow(row);
      attemptsByDelivery.set(attempt.deliveryId, [
        ...(attemptsByDelivery.get(attempt.deliveryId) ?? []),
        attempt,
      ]);
    }
    return {
      items: deliveries.map((delivery) => ({
        delivery,
        attempts: attemptsByDelivery.get(delivery.id) ?? [],
      })),
      hasMore: (deliveriesResult.results?.length ?? 0) > page.limit,
    };
  }
  async get(deliveryId: string) {
    const result = await this.database
      .prepare(`SELECT ${deliveryColumns} FROM communication_deliveries WHERE id = ? LIMIT 1`)
      .bind(deliveryId)
      .all<DeliveryRow>();
    this.ensure(result, "get delivery");
    return result.results?.[0] ? deliveryFromRow(result.results[0]) : null;
  }
  async leaseNext(now: string, leaseToken: string) {
    const staleBefore = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const claimed = await this.database
      .prepare(
        "UPDATE communication_deliveries SET lease_token = ?, updated_at = ? WHERE id = (SELECT id FROM communication_deliveries WHERE state IN ('queued', 'retrying') AND next_attempt_at <= ? AND (lease_token IS NULL OR updated_at <= ?) ORDER BY next_attempt_at, created_at LIMIT 1) AND (lease_token IS NULL OR updated_at <= ?)",
      )
      .bind(leaseToken, now, now, staleBefore, staleBefore)
      .run();
    this.ensure(claimed, "lease delivery");
    const result = await this.database
      .prepare(
        `SELECT ${deliveryColumns} FROM communication_deliveries WHERE lease_token = ? LIMIT 1`,
      )
      .bind(leaseToken)
      .all<DeliveryRow>();
    this.ensure(result, "load lease");
    return result.results?.[0] ? deliveryFromRow(result.results[0]) : null;
  }
  async complete(
    leaseToken: string,
    attempt: DeliveryAttempt,
    next: Pick<Delivery, "state" | "nextAttemptAt" | "updatedAt">,
    projection?: ProjectionState,
  ) {
    const statements = [
      this.database
        .prepare(
          "INSERT INTO communication_attempts (id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM communication_deliveries WHERE id = ? AND lease_token = ?)",
        )
        .bind(
          attempt.id,
          attempt.deliveryId,
          attempt.sequence,
          attempt.startedAt,
          attempt.completedAt,
          attempt.outcome,
          attempt.providerReference,
          attempt.errorCode,
          attempt.deliveryId,
          leaseToken,
        ),
      this.database
        .prepare(
          "UPDATE communication_deliveries SET state = ?, attempt_count = ?, next_attempt_at = ?, lease_token = NULL, updated_at = ? WHERE id = ? AND lease_token = ?",
        )
        .bind(
          next.state,
          attempt.sequence,
          next.nextAttemptAt,
          next.updatedAt,
          attempt.deliveryId,
          leaseToken,
        ),
    ];
    if (projection)
      statements.push(
        this.database
          .prepare(
            "INSERT INTO outbound_projection_state (destination, event_id, resource_ref, version, delivery_id, projected_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM communication_attempts WHERE id = ? AND delivery_id = ?) ON CONFLICT(destination, event_id, resource_ref) DO UPDATE SET version = excluded.version, delivery_id = excluded.delivery_id, projected_at = excluded.projected_at WHERE excluded.version >= outbound_projection_state.version",
          )
          .bind(
            projection.destination,
            projection.eventId,
            projection.resourceRef,
            projection.version,
            projection.deliveryId,
            projection.projectedAt,
            attempt.id,
            attempt.deliveryId,
          ),
      );
    const results = await this.database.batch(statements);
    for (const result of results) this.ensure(result, "complete delivery atomically");
    const recorded = await this.attempts(attempt.deliveryId);
    if (!recorded.some(({ id }) => id === attempt.id)) throw new Error("Delivery lease lost");
  }
  async retry(deliveryId: string, organizationId: string, now: string) {
    const result = await this.database
      .prepare(
        "UPDATE communication_deliveries SET state = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND state IN ('retrying', 'terminal') AND lease_token IS NULL",
      )
      .bind(now, now, deliveryId, organizationId)
      .run();
    this.ensure(result, "retry delivery");
    if ((result.meta?.changes ?? 0) !== 1)
      throw new DeliveryRecoveryConflictError("Delivery is not recoverable");
    const delivery = await this.get(deliveryId);
    if (!delivery || delivery.organizationId !== organizationId || delivery.state !== "queued")
      throw new Error("Delivery is not recoverable");
    return delivery;
  }
  async attempts(deliveryId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, delivery_id, sequence, started_at, completed_at, outcome, provider_reference, error_code FROM communication_attempts WHERE delivery_id = ? ORDER BY sequence",
      )
      .bind(deliveryId)
      .all<AttemptRow>();
    this.ensure(result, "list attempts");
    return (result.results ?? []).map(attemptFromRow);
  }
  async isProjectionSuperseded(delivery: Delivery) {
    if (delivery.channel === "email" || delivery.projectionVersion === null) return false;
    const result = await this.database
      .prepare(
        "SELECT id FROM communication_deliveries WHERE id != ? AND channel = ? AND event_id = ? AND recipient_ref = ? AND projection_version > ? LIMIT 1",
      )
      .bind(
        delivery.id,
        delivery.channel,
        delivery.eventId,
        delivery.recipientRef,
        delivery.projectionVersion,
      )
      .all<{ id: string }>();
    this.ensure(result, "check projection version");
    return Boolean(result.results?.length);
  }
}
