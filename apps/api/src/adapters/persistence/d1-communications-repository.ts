import {
  type CommunicationsRepository,
  DeliveryRecoveryConflictError,
  TemplateVersionTakenError,
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
  // `meta.changes` is what tells a conditional upsert apart from one whose WHERE guard declined
  // it: both are successful statements, and only the row count distinguishes them.
  batch(
    statements: Statement[],
  ): Promise<{ success: boolean; error?: string; meta?: { changes?: number } }[]>;
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

/**
 * `ON CONFLICT (organization_id, idempotency_key) DO NOTHING`, deliberately, rather than
 * `INSERT OR IGNORE`.
 *
 * The two behave identically on the duplicate this table exists to absorb, and differently on
 * everything else: `OR IGNORE` also swallows `CHECK`, `NOT NULL` and foreign-key violations, so
 * a malformed delivery would vanish and the insert would still report success. That matters most
 * for `preparedDeliveryWriter`, where the statement is committed inside another domain's batch
 * and nothing reloads the row afterwards — a swallowed violation there is a published schedule
 * with no delivery to announce it, which is the exact failure this API exists to prevent.
 */
const insertDeliveryStatement = (database: Database, delivery: Delivery): Statement =>
  database
    .prepare(
      `INSERT INTO communication_deliveries (${deliveryColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
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
 * cannot write a row this repository would not have written. The conflict clause on the
 * organization-scoped idempotency key keeps a retried command converging on one delivery, while
 * any other constraint failure still fails the caller's batch rather than vanishing from it.
 *
 * @spec PRD-COM-001 ARC-FLOW-002
 */
export const preparedDeliveryWriter =
  (database: Database): PreparedDeliveryWriter<Statement> =>
  (prepared) => [insertDeliveryStatement(database, prepared)];

/**
 * The `(organization, key, version)` uniqueness on `message_templates`, and nothing else.
 *
 * Narrowed to this table's own columns on purpose: the caller's response to `true` is either to
 * read again and claim the next version, or to report a conflict to the organizer. Retrying is
 * the wrong answer to any other constraint, and a broader test would turn a foreign-key failure
 * on `organization_id` into an allocation loop that never explains itself.
 *
 * SQLite words the two forms differently, and D1 puts the message on the error while Miniflare
 * sometimes puts it only on the cause; all four combinations are covered here.
 */
const isTemplateVersionTaken = (error: unknown): boolean => {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error ?? "");
  if (!text.includes("UNIQUE constraint failed") && !text.includes("PRIMARY KEY must be unique"))
    return false;
  return (
    text.includes("message_templates.version") || text.includes("message_templates.template_key")
  );
};

export class D1CommunicationsRepository implements CommunicationsRepository {
  constructor(private readonly database: Database) {}
  private ensure(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
  }
  async createTemplate(template: MessageTemplate) {
    const insert = this.database
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
      );
    /*
     * The uniqueness failure is told apart from every other storage failure, because it is the
     * ordinary outcome of two organizers publishing the same key at once rather than a fault.
     * Before this it reached the transport as a 500.
     *
     * D1 raises it as a rejected promise in some paths and as an unsuccessful result in others,
     * so both are checked. Matching on the message is unavoidable — D1 exposes no error code —
     * and it is narrowed to this table's constraint so a different uniqueness failure is not
     * silently reported as a version collision.
     */
    let result: { success: boolean; error?: string };
    try {
      result = await insert.run();
    } catch (error) {
      if (isTemplateVersionTaken(error))
        throw new TemplateVersionTakenError("Template version already exists");
      throw error;
    }
    if (isTemplateVersionTaken(result.error))
      throw new TemplateVersionTakenError("Template version already exists");
    this.ensure(result, "create template");
  }
  async latestTemplateVersion(organizationId: string, key: string) {
    const result = await this.database
      .prepare(
        "SELECT MAX(version) AS latest FROM message_templates WHERE organization_id = ? AND template_key = ?",
      )
      .bind(organizationId, key)
      .all<{ latest: number | null }>();
    this.ensure(result, "read the latest template version");
    return result.results?.[0]?.latest ?? 0;
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
  /**
   * D1 binds at most 100 parameters per statement, and the organization consumes one of them.
   *
   * Worth stating because of *when* it would have bitten: the reload runs after the insert batch
   * has committed, so a send to a hundred speakers would have queued every delivery and then
   * answered the organizer with an error. Chunking keeps the read within the limit.
   */
  private static readonly RELOAD_CHUNK = 99;

  private async byKeys(organizationId: string, keys: readonly string[]) {
    const found = new Map<string, Delivery>();
    for (let start = 0; start < keys.length; start += D1CommunicationsRepository.RELOAD_CHUNK) {
      const chunk = keys.slice(start, start + D1CommunicationsRepository.RELOAD_CHUNK);
      const result = await this.database
        .prepare(
          `SELECT ${deliveryColumns} FROM communication_deliveries WHERE organization_id = ? AND idempotency_key IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(organizationId, ...chunk)
        .all<DeliveryRow>();
      this.ensure(result, "reload enqueued deliveries");
      for (const row of result.results ?? []) found.set(row.idempotency_key, deliveryFromRow(row));
    }
    return found;
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
    return (await this.byKeys(organizationId, [idempotencyKey])).get(idempotencyKey) ?? null;
  }

  /**
   * One batch, then one read, whatever the audience size.
   *
   * Two statements per recipient would spend a Worker invocation's subrequest budget partway
   * through a large event, leaving half the speakers durably queued and the organizer told the
   * send failed. The reload is keyed by idempotency key rather than id so the row a previous
   * send already wrote comes back as itself — that is what lets the caller count what it
   * actually created.
   */
  async enqueueMany(deliveries: readonly Delivery[]): Promise<readonly Delivery[]> {
    if (deliveries.length === 0) return [];
    const organizationId = deliveries[0]?.organizationId as string;
    const results = await this.database.batch(
      deliveries.map((delivery) => insertDeliveryStatement(this.database, delivery)),
    );
    for (const result of results) this.ensure(result, "enqueue deliveries");
    const stored = await this.byKeys(
      organizationId,
      deliveries.map((delivery) => delivery.idempotencyKey),
    );
    return deliveries.map((delivery) => {
      const row = stored.get(delivery.idempotencyKey);
      if (!row) throw new Error("D1 did not return an enqueued delivery");
      return row;
    });
  }

  async listTemplates(organizationId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, organization_id, template_key, version, channel, subject, body, created_at FROM message_templates WHERE organization_id = ? ORDER BY template_key, version DESC",
      )
      .bind(organizationId)
      .all<TemplateRow>();
    this.ensure(result, "list templates");
    return (result.results ?? []).map(templateFromRow);
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
    const projectionStatement = projection ? statements.length : -1;
    if (projection) {
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
      // The repair, in the same batch as the attempt that made it necessary.
      //
      // Reached only when the upsert above was refused — the recorded version is strictly newer
      // than this delivery's, so this delivery's provider call was the late one and the external
      // system is now holding older data than the database records. Re-queuing the delivery that
      // owns the recorded version re-sends the winning payload; because every projection adapter
      // upserts on the resource reference, that converges rather than duplicating.
      //
      // It is in the batch rather than in the worker because the refusal is observable exactly
      // once. A worker that noticed it, then failed before writing the repair, would leave a
      // stale external record nothing could detect again — the attempt is already durable, and
      // no later drain re-derives it.
      //
      // Terminates: the re-send records a version equal to the recorded one, which `>=` accepts,
      // so `version > ?` is false the second time round and no further repair is queued.
      statements.push(
        this.database
          .prepare(
            "UPDATE communication_deliveries SET state = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = (SELECT delivery_id FROM outbound_projection_state WHERE destination = ? AND event_id = ? AND resource_ref = ? AND version > ?) AND state = 'succeeded' AND lease_token IS NULL AND EXISTS (SELECT 1 FROM communication_attempts WHERE id = ? AND delivery_id = ?)",
          )
          .bind(
            projection.projectedAt,
            projection.projectedAt,
            projection.destination,
            projection.eventId,
            projection.resourceRef,
            projection.version,
            attempt.id,
            attempt.deliveryId,
          ),
      );
    }
    const results = await this.database.batch(statements);
    for (const result of results) this.ensure(result, "complete delivery atomically");
    const recorded = await this.attempts(attempt.deliveryId);
    if (!recorded.some(({ id }) => id === attempt.id)) throw new Error("Delivery lease lost");
    // The upsert changed no row exactly when its version guard refused it. Without a projection
    // there is nothing to be stale, so nothing to report.
    //
    // A missing `meta` defaults to *applied*. D1 and miniflare both return it, so this is the
    // "driver told us nothing" case, and the safe default for an alarm is silence: reading absence
    // as a refusal would report a stale external projection on every projection delivery, which
    // would train an operator to ignore the one signal that is supposed to be rare.
    return {
      projectionApplied:
        projectionStatement < 0 || (results[projectionStatement]?.meta?.changes ?? 1) > 0,
    };
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
        // `state != 'terminal'` is load-bearing. Supersession means "a newer version has been sent
        // or is still going to be"; a newer delivery that failed terminally will never be sent, so
        // treating it as superseding this one abandons the newest version anybody can still
        // deliver. That is reachable: a v3 that exhausts its retries would otherwise strand v2 —
        // including the v2 the stale-projection repair just re-queued — leaving the external
        // system on v1 with nothing left to correct it.
        "SELECT id FROM communication_deliveries WHERE id != ? AND channel = ? AND event_id = ? AND recipient_ref = ? AND projection_version > ? AND state != 'terminal' LIMIT 1",
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
