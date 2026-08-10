import type { CommunicationsRepository } from "../../application/communications/ports";
import type {
  Delivery,
  DeliveryAttempt,
  MessageTemplate,
  ProjectionState,
} from "../../domain/communications/delivery";

export class MemoryCommunicationsRepository implements CommunicationsRepository {
  private readonly templates: MessageTemplate[] = [];
  private readonly deliveries = new Map<string, Delivery>();
  private readonly attemptLog: DeliveryAttempt[] = [];
  readonly projections = new Map<string, ProjectionState>();

  async createTemplate(template: MessageTemplate): Promise<void> {
    if (
      this.templates.some(
        (item) =>
          item.organizationId === template.organizationId &&
          item.key === template.key &&
          item.version === template.version,
      )
    )
      throw new Error("Template version already exists");
    this.templates.push(template);
  }

  async findTemplate(organizationId: string, key: string, version?: number) {
    return (
      this.templates
        .filter(
          (item) =>
            item.organizationId === organizationId &&
            item.key === key &&
            (version === undefined || item.version === version),
        )
        .sort((left, right) => right.version - left.version)[0] ?? null
    );
  }

  async enqueue(delivery: Delivery): Promise<Delivery> {
    const existing = [...this.deliveries.values()].find(
      (item) =>
        item.organizationId === delivery.organizationId &&
        item.idempotencyKey === delivery.idempotencyKey,
    );
    if (existing) return existing;
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  async list(organizationId: string, eventId: string) {
    return [...this.deliveries.values()]
      .filter((item) => item.organizationId === organizationId && item.eventId === eventId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(deliveryId: string) {
    return this.deliveries.get(deliveryId) ?? null;
  }

  async leaseNext(now: string, leaseToken: string): Promise<Delivery | null> {
    const delivery = [...this.deliveries.values()]
      .filter(
        (item) =>
          (item.state === "queued" || item.state === "retrying") &&
          !item.leaseToken &&
          item.nextAttemptAt <= now,
      )
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0];
    if (!delivery) return null;
    const leased = { ...delivery, leaseToken };
    this.deliveries.set(leased.id, leased);
    return leased;
  }

  async complete(
    leaseToken: string,
    attempt: DeliveryAttempt,
    next: Pick<Delivery, "state" | "nextAttemptAt" | "updatedAt">,
    projection?: ProjectionState,
  ): Promise<void> {
    const delivery = this.deliveries.get(attempt.deliveryId);
    if (!delivery || delivery.leaseToken !== leaseToken) throw new Error("Delivery lease lost");
    if (this.attemptLog.some((item) => item.id === attempt.id)) return;
    this.attemptLog.push(attempt);
    this.deliveries.set(delivery.id, {
      ...delivery,
      ...next,
      attemptCount: attempt.sequence,
      leaseToken: null,
    });
    if (projection) {
      const key = `${projection.destination}:${projection.eventId}:${projection.resourceRef}`;
      const current = this.projections.get(key);
      if (!current || projection.version >= current.version) this.projections.set(key, projection);
    }
  }

  async retry(deliveryId: string, organizationId: string, now: string): Promise<Delivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.organizationId !== organizationId)
      throw new Error("Delivery not found");
    if (delivery.state !== "terminal" && delivery.state !== "retrying")
      throw new Error("Delivery is not recoverable");
    const retried = { ...delivery, state: "queued" as const, nextAttemptAt: now, updatedAt: now };
    this.deliveries.set(deliveryId, retried);
    return retried;
  }

  async attempts(deliveryId: string) {
    return this.attemptLog.filter((item) => item.deliveryId === deliveryId);
  }
}
