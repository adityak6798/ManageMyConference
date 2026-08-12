import {
  type CommunicationsRepository,
  type DeliveryCompletion,
  type CalendarInviteState,
  DeliveryRecoveryConflictError,
  TemplateVersionTakenError,
} from "../../application/communications/ports";
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
  private readonly calendarInvites = new Map<string, CalendarInviteState>();

  private calendarInviteKey(
    state: Pick<
      CalendarInviteState,
      "organizationId" | "eventId" | "sessionId" | "speakerProfileId"
    >,
  ) {
    return `${state.organizationId}:${state.eventId}:${state.sessionId}:${state.speakerProfileId}`;
  }

  async createTemplate(template: MessageTemplate): Promise<void> {
    if (
      this.templates.some(
        (item) =>
          item.organizationId === template.organizationId &&
          item.key === template.key &&
          item.version === template.version,
      )
    )
      throw new TemplateVersionTakenError("Template version already exists");
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

  async latestTemplateVersion(organizationId: string, key: string) {
    return this.templates
      .filter((template) => template.organizationId === organizationId && template.key === key)
      .reduce((highest, template) => Math.max(highest, template.version), 0);
  }
  async listTemplates(organizationId: string) {
    return this.templates
      .filter((template) => template.organizationId === organizationId)
      .sort(
        (left, right) =>
          left.key.localeCompare(right.key) ||
          right.version - left.version ||
          left.id.localeCompare(right.id),
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

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
    return (
      [...this.deliveries.values()].find(
        (item) => item.organizationId === organizationId && item.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async enqueueMany(deliveries: readonly Delivery[]): Promise<readonly Delivery[]> {
    const stored: Delivery[] = [];
    for (const delivery of deliveries) stored.push(await this.enqueue(delivery));
    return stored;
  }

  async calendarInviteState(
    organizationId: string,
    eventId: string,
    sessionId: string,
    speakerProfileId: string,
  ) {
    return (
      this.calendarInvites.get(
        this.calendarInviteKey({ organizationId, eventId, sessionId, speakerProfileId }),
      ) ?? null
    );
  }

  async enqueueCalendarInvite(
    delivery: Delivery,
    state: CalendarInviteState,
    expectedSequence: number | null,
  ) {
    const key = this.calendarInviteKey(state);
    const current = this.calendarInvites.get(key);
    if ((current?.sequence ?? null) !== expectedSequence) return null;
    const stored = await this.enqueue(delivery);
    this.calendarInvites.set(key, { ...state, deliveryId: stored.id });
    return stored;
  }

  async normalizeCalendarInviteScheduleRef(
    state: CalendarInviteState,
    expectedScheduleRef: string,
  ) {
    const key = this.calendarInviteKey(state);
    const current = this.calendarInvites.get(key);
    if (current?.scheduleRef !== expectedScheduleRef || current.sequence !== state.sequence)
      return false;
    this.calendarInvites.set(key, state);
    return true;
  }

  async list(organizationId: string, eventId: string) {
    return [...this.deliveries.values()]
      .filter((item) => item.organizationId === organizationId && item.eventId === eventId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }

  async historyPage(
    organizationId: string,
    eventId: string,
    page: { limit: number; after?: { createdAt: string; id: string } },
  ) {
    const eligible = (await this.list(organizationId, eventId)).filter((delivery) => {
      if (!page.after) return true;
      return (
        delivery.createdAt > page.after.createdAt ||
        (delivery.createdAt === page.after.createdAt && delivery.id > page.after.id)
      );
    });
    const selected = eligible.slice(0, page.limit);
    return {
      items: selected.map((delivery) => ({
        delivery,
        attempts: this.attemptLog.filter((attempt) => attempt.deliveryId === delivery.id),
      })),
      hasMore: eligible.length > page.limit,
    };
  }

  async get(deliveryId: string) {
    return this.deliveries.get(deliveryId) ?? null;
  }

  async leaseNext(now: string, leaseToken: string): Promise<Delivery | null> {
    const staleBefore = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const delivery = [...this.deliveries.values()]
      .filter(
        (item) =>
          (item.state === "queued" || item.state === "retrying") &&
          (!item.leaseToken || item.updatedAt <= staleBefore) &&
          item.nextAttemptAt <= now,
      )
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0];
    if (!delivery) return null;
    const leased = { ...delivery, leaseToken, updatedAt: now };
    this.deliveries.set(leased.id, leased);
    return leased;
  }

  async complete(
    leaseToken: string,
    attempt: DeliveryAttempt,
    next: Pick<Delivery, "state" | "nextAttemptAt" | "updatedAt">,
    projection?: ProjectionState,
  ): Promise<DeliveryCompletion> {
    const delivery = this.deliveries.get(attempt.deliveryId);
    if (!delivery || delivery.leaseToken !== leaseToken) throw new Error("Delivery lease lost");
    // `true`, matching the SQL: re-completing an already-recorded attempt re-runs the upsert with
    // an equal version, which the `>=` guard accepts. Answering `false` here would report a stale
    // external projection for a completion where nothing was refused and no repair was queued —
    // and `staleProjectionRepaired` is only worth having because it is normally never true.
    if (this.attemptLog.some((item) => item.id === attempt.id)) return { projectionApplied: true };
    this.attemptLog.push(attempt);
    this.deliveries.set(delivery.id, {
      ...delivery,
      ...next,
      attemptCount: attempt.sequence,
      leaseToken: null,
    });
    if (!projection) return { projectionApplied: true };
    const key = `${projection.destination}:${projection.eventId}:${projection.resourceRef}`;
    const current = this.projections.get(key);
    const applied = !current || projection.version >= current.version;
    if (applied) this.projections.set(key, projection);
    // Mirrors the D1 batch: a refused projection means this delivery's provider call landed after
    // a newer one, so the external system now holds older data than this repository records. The
    // delivery owning the recorded version is re-queued to re-send the winning payload. See the
    // statement in `d1-communications-repository.ts` for why the repair belongs beside the write.
    if (!applied && current) {
      const owner = this.deliveries.get(current.deliveryId);
      if (owner && owner.state === "succeeded" && !owner.leaseToken)
        this.deliveries.set(owner.id, {
          ...owner,
          state: "queued",
          nextAttemptAt: projection.projectedAt,
          updatedAt: projection.projectedAt,
        });
    }
    return { projectionApplied: applied };
  }

  async retry(deliveryId: string, organizationId: string, now: string): Promise<Delivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.organizationId !== organizationId)
      throw new DeliveryRecoveryConflictError("Delivery not found");
    if (delivery.leaseToken)
      throw new DeliveryRecoveryConflictError("Delivery is currently leased");
    if (delivery.state !== "terminal" && delivery.state !== "retrying")
      throw new DeliveryRecoveryConflictError("Delivery is not recoverable");
    const retried = { ...delivery, state: "queued" as const, nextAttemptAt: now, updatedAt: now };
    this.deliveries.set(deliveryId, retried);
    return retried;
  }

  async attempts(deliveryId: string) {
    return this.attemptLog.filter((item) => item.deliveryId === deliveryId);
  }

  async isProjectionSuperseded(delivery: Delivery) {
    const projectionVersion = delivery.projectionVersion;
    if (delivery.channel === "email" || projectionVersion === null) return false;
    return [...this.deliveries.values()].some(
      (candidate) =>
        candidate.id !== delivery.id &&
        candidate.channel === delivery.channel &&
        candidate.eventId === delivery.eventId &&
        candidate.recipientRef === delivery.recipientRef &&
        candidate.projectionVersion !== null &&
        candidate.projectionVersion > projectionVersion &&
        // A terminally failed newer version will never be sent, so it must not supersede this one.
        // See the SQL for why abandoning the newest deliverable version is the failure that
        // matters.
        candidate.state !== "terminal",
    );
  }
}
