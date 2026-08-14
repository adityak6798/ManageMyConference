// @spec PRD-INT-001
export type WebhookEventType = "schedule.published";
export type WebhookState = "active" | "disabled";
export type WebhookDeliveryState = "queued" | "retrying" | "succeeded" | "terminal";

export interface WebhookSubscription {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string | null;
  readonly url: string;
  /** Recoverable HMAC key material. Outbound signing cannot use a one-way digest. */
  readonly secretMaterial: string;
  readonly previousSecretMaterial: string | null;
  readonly previousSecretExpiresAt: string | null;
  readonly eventTypes: readonly WebhookEventType[];
  readonly state: WebhookState;
  readonly createdAt: string;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  /** Internal optimistic-concurrency token; transport projections omit it. */
  readonly revision: number;
}

export interface WebhookPayload {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly version: 1;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly subscriptionId: string;
  readonly organizationId: string;
  readonly eventId: string | null;
  readonly eventRecordId: string;
  readonly eventType: WebhookEventType;
  readonly idempotencyKey: string;
  readonly payload: WebhookPayload;
  readonly state: WebhookDeliveryState;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly leaseToken: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookDeliveryAttempt {
  readonly id: string;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "retryable_failure" | "terminal_failure";
  readonly errorCode: string | null;
  readonly requestedBy: string | null;
}
