import type {
  Delivery,
  DeliveryAttempt,
  MessageTemplate,
  ProjectionState,
} from "../../domain/communications/delivery";

export type ProviderResult =
  | { readonly kind: "success"; readonly providerReference: string }
  | { readonly kind: "retryable"; readonly code: string }
  | { readonly kind: "terminal"; readonly code: string };

export class DeliveryRecoveryConflictError extends Error {}

/**
 * Another template version with this `(organization, key, version)` already exists.
 *
 * Named rather than left as the raw uniqueness failure because the two callers want opposite
 * things from it: the allocator treats it as "somebody took that number, read again and try the
 * next", while an organizer who pinned a version explicitly needs it reported as a conflict.
 * Before this, both produced a 500.
 */
export class TemplateVersionTakenError extends Error {}

export interface CalendarInviteState {
  readonly organizationId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly speakerProfileId: string;
  readonly scheduleRef: string;
  readonly recipientRef: string;
  readonly sequence: number;
  readonly deliveryId: string;
}

export interface DeliveryProvider {
  deliver(delivery: Delivery): Promise<ProviderResult>;
}

/** What `complete` durably did, for the caller that has to report it. */
export interface DeliveryCompletion {
  /**
   * Whether this delivery's version is the one `outbound_projection_state` now records.
   *
   * `false` means the projection write was refused because a newer version had already landed —
   * so this delivery's provider call was a late one that overwrote fresher data in the external
   * system. It is the only signal that the external system is now stale, and it exists because
   * nothing else can observe it: the refusal is a `WHERE` clause that declines to update a row,
   * which is a perfectly successful statement.
   *
   * Always `true` when no projection accompanied the completion, including for every email
   * delivery — there is nothing to be stale.
   */
  readonly projectionApplied: boolean;
}

/**
 * Acts on an `event`-channel delivery — a domain event another domain committed durably.
 *
 * Returns the same `ProviderResult` a provider does, deliberately: consuming an event can fail
 * halfway just as a send can, and reusing the shape means the bounded retry, the immutable
 * attempt history and the terminal state after three tries all apply without a second
 * mechanism. A consumer whose work is idempotent — and it must be, because the outbox is
 * at-least-once — can therefore be retried by the machinery that already exists.
 */
export interface DomainEventConsumer {
  consume(delivery: Delivery): Promise<ProviderResult>;
}

// @spec PRD-COM-001 PRD-INT-001
export interface CommunicationsRepository {
  createTemplate(template: MessageTemplate): Promise<void>;
  findTemplate(
    organizationId: string,
    key: string,
    version?: number,
  ): Promise<MessageTemplate | null>;
  /** Every version in the organization, by key, newest version first. None is hidden. */
  listTemplates(organizationId: string): Promise<readonly MessageTemplate[]>;
  /**
   * The highest version stored for this key, or 0 when the key is new.
   *
   * Read immediately before the insert that claims the next one. The read is not a reservation
   * and cannot be — two organizers can read the same number — so the insert's unique constraint
   * is the arbiter and `TemplateVersionTakenError` is how the loser is told to try again.
   */
  latestTemplateVersion(organizationId: string, key: string): Promise<number>;
  /** The delivery already holding this key, if a previous enqueue wrote one. */
  findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<Delivery | null>;
  /**
   * How many deliveries this event has already written to one address (issue #132).
   *
   * The durable half of the unverified-recipient cap. There is **no counter table**, for the same
   * reason the reminder keys carry no bookkeeping: the deliveries *are* the record, they are the
   * thing an organizer can already read and retry, and a count derived from them cannot drift
   * from what was actually sent. Scoped to the event, because an address that agreed to hear from
   * one conference has agreed to nothing about another.
   */
  countDeliveriesTo(organizationId: string, eventId: string, recipientRef: string): Promise<number>;
  enqueue(delivery: Delivery): Promise<Delivery>;
  /**
   * Enqueue many in one durable round trip, returning each stored row in request order.
   *
   * A send to an event's speakers is one action, not N; issuing two statements per recipient
   * costs a Worker invocation its subrequest budget partway through a large event and leaves
   * half the audience durably queued with nothing reported. The returned row is the *stored*
   * one, so a caller can tell a delivery it created from one an earlier send already made by
   * comparing identity.
   */
  enqueueMany(deliveries: readonly Delivery[]): Promise<readonly Delivery[]>;
  calendarInviteState(
    organizationId: string,
    eventId: string,
    sessionId: string,
    speakerProfileId: string,
  ): Promise<CalendarInviteState | null>;
  /**
   * Advance the invitation state and enqueue its REQUEST in one commit.
   *
   * Null means another caller advanced the pair first; the application re-reads and either
   * returns that identical invitation or tries the next sequence for its different schedule.
   */
  enqueueCalendarInvite(
    delivery: Delivery,
    state: CalendarInviteState,
    expectedSequence: number | null,
  ): Promise<Delivery | null>;
  normalizeCalendarInviteScheduleRef(
    state: CalendarInviteState,
    expectedScheduleRef: string,
  ): Promise<boolean>;
  list(organizationId: string, eventId: string): Promise<readonly Delivery[]>;
  historyPage(
    organizationId: string,
    eventId: string,
    page: { limit: number; after?: { createdAt: string; id: string } },
  ): Promise<{
    items: readonly { delivery: Delivery; attempts: readonly DeliveryAttempt[] }[];
    hasMore: boolean;
  }>;
  get(deliveryId: string): Promise<Delivery | null>;
  leaseNext(now: string, leaseToken: string): Promise<Delivery | null>;
  /**
   * Append the attempt, move the delivery, and record the projection — atomically.
   *
   * When `projection` is supplied and a newer version has already been recorded for the same
   * destination/event/resource, two things happen in the same durable batch: the projection row
   * is left alone, and the delivery that owns that newer version is re-queued so its payload is
   * sent again. That re-send is the repair for a late provider call having overwritten the
   * external system with older data — see `DeliveryCompletion.projectionApplied` and
   * `docs/architecture/integrations.md#a-late-projection-can-leave-the-external-system-stale`.
   */
  complete(
    leaseToken: string,
    attempt: DeliveryAttempt,
    next: Pick<Delivery, "state" | "nextAttemptAt" | "updatedAt">,
    projection?: ProjectionState,
  ): Promise<DeliveryCompletion>;
  retry(deliveryId: string, organizationId: string, now: string): Promise<Delivery>;
  attempts(deliveryId: string): Promise<readonly DeliveryAttempt[]>;
  isProjectionSuperseded(delivery: Delivery): Promise<boolean>;
}
