/**
 * A reusable, versioned capture of one event's configuration.
 *
 * A template holds *configuration only*. What that means concretely is enumerated by the
 * slices in `application/events/template-ports.ts`; what it excludes — submissions, people,
 * private content, deliveries, published snapshots, secrets, audit rows — is asserted as a
 * test rather than promised in a comment (`ACC-EVENT-TEMPLATES`).
 *
 * @spec PRD-EVT-002
 */

export type EventTemplateState = "active" | "archived";

export interface EventTemplate {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly state: EventTemplateState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One domain's contribution to a captured template, as it was serialized.
 *
 * Opaque to events on purpose: the slice that wrote it is the only thing that may read it.
 * `null` records "this domain had nothing to export", which is a different answer from a key
 * that is absent because the slice did not exist when the version was captured.
 */
export type EventTemplateSlicePayload = unknown | null;

export interface EventTemplatePayload {
  readonly capturedAt: string;
  readonly source: {
    readonly eventId: string;
    readonly eventName: string;
    readonly timezone: string;
  };
  readonly slices: Readonly<Record<string, EventTemplateSlicePayload>>;
}

export interface EventTemplateVersion {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly payload: EventTemplatePayload;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** A version as a list reads it: provenance without the payload. */
export interface EventTemplateVersionSummary {
  readonly id: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly createdAt: string;
  readonly createdBy: string;
  /** The slice keys this version actually carries something for. */
  readonly slices: readonly string[];
}
