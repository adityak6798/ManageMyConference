import type { DeliveryProvider, ProviderResult } from "./ports";
import type { CommunicationsRepository } from "./ports";

const retryDelayMs = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));

// @spec PRD-COM-001 PRD-INT-001
export class OutboxWorker {
  constructor(
    private readonly repository: CommunicationsRepository,
    private readonly providers: Record<"email" | "airtable" | "accelevents", DeliveryProvider>,
    private readonly dependencies: { newId(): string; now(): Date },
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
    let result: ProviderResult;
    try {
      result = await this.providers[delivery.channel].deliver(delivery);
    } catch {
      // ERROR-INTENT: Provider details are untrusted; normalize the failure into an auditable retry.
      result = { kind: "retryable" as const, code: "UNEXPECTED_PROVIDER_ERROR" };
    }
    const completedAt = this.dependencies.now().toISOString();
    const sequence = delivery.attemptCount + 1;
    const state =
      result.kind === "success"
        ? "succeeded"
        : result.kind === "terminal"
          ? "terminal"
          : "retrying";
    const nextAttemptAt =
      result.kind === "retryable"
        ? new Date(this.dependencies.now().getTime() + retryDelayMs(sequence)).toISOString()
        : completedAt;
    await this.repository.complete(
      leaseToken,
      {
        id: this.dependencies.newId(),
        deliveryId: delivery.id,
        sequence,
        startedAt,
        completedAt,
        outcome:
          result.kind === "success"
            ? "succeeded"
            : result.kind === "retryable"
              ? "retryable_failure"
              : "terminal_failure",
        providerReference: result.kind === "success" ? result.providerReference : null,
        errorCode: result.kind === "success" ? null : result.code,
      },
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
    return true;
  }
}
