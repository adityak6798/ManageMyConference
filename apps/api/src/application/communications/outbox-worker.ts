import type { DeliveryProvider, ProviderResult } from "./ports";
import type { CommunicationsRepository } from "./ports";

const retryDelayMs = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));

/**
 * What one provider call did, for the operational log.
 *
 * Deliberately made of identifiers and normalized codes only. A delivery's recipient, its
 * rendered message and its payload are all absent: this line goes to a shared sink, and an
 * outbox that leaks a speaker's address into it every minute is a worse problem than the one
 * the telemetry solves. `deliveryId` and `idempotencyKey` are enough to find the row, and the
 * row holds the rest under the same authorization as the history view.
 */
export interface DeliveryAttemptRecord {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly channel: string;
  readonly triggerType: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly providerReference: string | null;
}

export interface OutboxTelemetry {
  attempt(record: DeliveryAttemptRecord): void;
}

// @spec PRD-COM-001 PRD-INT-001 ARC-OBS-001
export class OutboxWorker {
  constructor(
    private readonly repository: CommunicationsRepository,
    private readonly providers: Record<"email" | "airtable" | "accelevents", DeliveryProvider>,
    private readonly dependencies: { newId(): string; now(): Date },
    private readonly telemetry?: OutboxTelemetry,
  ) {}

  async runOne(): Promise<boolean> {
    const leaseToken = this.dependencies.newId();
    const delivery = await this.repository.leaseNext(
      this.dependencies.now().toISOString(),
      leaseToken,
    );
    if (!delivery) return false;

    // The durable lease is committed before this provider call; no DB transaction is open here.
    const startedAt = this.dependencies.now().toISOString();
    const sequence = delivery.attemptCount + 1;
    if (await this.repository.isProjectionSuperseded(delivery)) {
      await this.repository.complete(
        leaseToken,
        {
          id: this.dependencies.newId(),
          deliveryId: delivery.id,
          sequence,
          startedAt,
          completedAt: startedAt,
          outcome: "terminal_failure",
          providerReference: null,
          errorCode: "PROJECTION_SUPERSEDED",
        },
        { state: "terminal", nextAttemptAt: startedAt, updatedAt: startedAt },
      );
      return true;
    }
    let result: ProviderResult;
    try {
      result = await this.providers[delivery.channel].deliver(delivery);
    } catch {
      // ERROR-INTENT: Provider details are untrusted; normalize the failure into an auditable retry.
      result = { kind: "retryable" as const, code: "UNEXPECTED_PROVIDER_ERROR" };
    }
    const completedAt = this.dependencies.now().toISOString();
    const retryExhausted = result.kind === "retryable" && sequence >= 3;
    const state =
      result.kind === "success"
        ? "succeeded"
        : result.kind === "terminal" || retryExhausted
          ? "terminal"
          : "retrying";
    const nextAttemptAt =
      result.kind === "retryable"
        ? new Date(this.dependencies.now().getTime() + retryDelayMs(sequence)).toISOString()
        : completedAt;
    const attempt = {
      id: this.dependencies.newId(),
      deliveryId: delivery.id,
      sequence,
      startedAt,
      completedAt,
      outcome:
        result.kind === "success"
          ? ("succeeded" as const)
          : result.kind === "retryable" && !retryExhausted
            ? ("retryable_failure" as const)
            : ("terminal_failure" as const),
      providerReference: result.kind === "success" ? result.providerReference : null,
      errorCode:
        result.kind === "success"
          ? null
          : retryExhausted
            ? `RETRY_EXHAUSTED:${result.code}`
            : result.code,
    };
    await this.repository.complete(
      leaseToken,
      attempt,
      { state, nextAttemptAt, updatedAt: completedAt },
      result.kind === "success" &&
        delivery.channel !== "email" &&
        delivery.projectionVersion !== null
        ? {
            destination: delivery.channel,
            eventId: delivery.eventId,
            resourceRef: delivery.recipientRef,
            version: delivery.projectionVersion,
            deliveryId: delivery.id,
            projectedAt: completedAt,
          }
        : undefined,
    );
    // Emitted after the attempt is durable, so the log never claims an outcome the database
    // does not hold, and guarded because a telemetry sink is not worth the queue: a throwing
    // logger would abort this drain and leave every remaining eligible delivery waiting for the
    // next tick.
    try {
      this.telemetry?.attempt({
        deliveryId: delivery.id,
        idempotencyKey: delivery.idempotencyKey,
        channel: delivery.channel,
        triggerType: delivery.triggerType,
        sequence,
        outcome: attempt.outcome,
        errorCode: attempt.errorCode,
        providerReference: attempt.providerReference,
      });
    } catch {
      // ERROR-INTENT: the attempt is already durable and readable in the delivery history; a
      // failed log line must not stall the outbox for every other queued delivery. The delivery
      // was processed either way, which is what the return value means.
      return true;
    }
    return true;
  }
}
