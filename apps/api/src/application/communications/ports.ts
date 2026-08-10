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

export interface DeliveryProvider {
  deliver(delivery: Delivery): Promise<ProviderResult>;
}

// @spec PRD-COM-001 PRD-INT-001
export interface CommunicationsRepository {
  createTemplate(template: MessageTemplate): Promise<void>;
  findTemplate(
    organizationId: string,
    key: string,
    version?: number,
  ): Promise<MessageTemplate | null>;
  enqueue(delivery: Delivery): Promise<Delivery>;
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
