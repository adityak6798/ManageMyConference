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

export interface DeliveryProvider {
  deliver(delivery: Delivery): Promise<ProviderResult>;
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
  complete(
    leaseToken: string,
    attempt: DeliveryAttempt,
    next: Pick<Delivery, "state" | "nextAttemptAt" | "updatedAt">,
    projection?: ProjectionState,
  ): Promise<void>;
  retry(deliveryId: string, organizationId: string, now: string): Promise<Delivery>;
  attempts(deliveryId: string): Promise<readonly DeliveryAttempt[]>;
  isProjectionSuperseded(delivery: Delivery): Promise<boolean>;
}
