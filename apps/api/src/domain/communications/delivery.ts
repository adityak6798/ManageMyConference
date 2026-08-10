// @spec PRD-COM-001 PRD-INT-001
export type DeliveryChannel = "email" | "airtable" | "accelevents";
export type DeliveryState = "queued" | "retrying" | "succeeded" | "terminal";
export type TriggerType =
  | "speaker.invited"
  | "reviewer.assigned"
  | "organizer.digest"
  | "projection.requested";

export interface MessageTemplate {
  readonly id: string;
  readonly organizationId: string;
  readonly key: string;
  readonly version: number;
  readonly channel: DeliveryChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface Delivery {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly triggerType: TriggerType;
  readonly channel: DeliveryChannel;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly recipientRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectionVersion: number | null;
  readonly state: DeliveryState;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly leaseToken: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryAttempt {
  readonly id: string;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "retryable_failure" | "terminal_failure";
  readonly providerReference: string | null;
  readonly errorCode: string | null;
}

export interface ProjectionState {
  readonly destination: "airtable" | "accelevents";
  readonly eventId: string;
  readonly resourceRef: string;
  readonly version: number;
  readonly deliveryId: string;
  readonly projectedAt: string;
}
