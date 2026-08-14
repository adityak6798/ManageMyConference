// @spec PRD-COM-001 PRD-INT-001

/**
 * Where a delivery goes.
 *
 * `event` is the odd one and deliberately so. The other three name an outside system this domain
 * calls over HTTP; `event` names no system at all. It carries a domain event that another domain
 * committed — today only `EVT-SCHEDULE-PUBLISHED` — through the same durable machinery, so the
 * announcement of a fact and the fact itself commit together and the announcement is retried,
 * attempted and audited like anything else that has to happen exactly once.
 *
 * Modelling it as an `airtable` delivery instead, which is the shortcut this replaces, would
 * have queued a fabricated push to somebody's Airtable base and written projection state
 * claiming the schedule had been sent there. See issue #22 and PR #113's scoping note.
 */
export type DeliveryChannel = "email" | "airtable" | "accelevents" | "event";
export type DeliveryState = "queued" | "retrying" | "succeeded" | "terminal";
export type TriggerType =
  | "speaker.invited"
  | "reviewer.assigned"
  | "organizer.digest"
  | "projection.requested"
  | "schedule.published"
  | "speaker.scheduled"
  | "speaker.task_assigned"
  | "speaker.task_reminder"
  /** An organizer sending a speaker the iTIP invitation for one of their sessions. */
  | "speaker.calendar_invite"
  | "decision.recorded"
  /**
   * A submitter's own proposal reaching the organizers, confirmed back to the account that wrote
   * it.
   *
   * The recipient is resolved from the session that submitted, never from a form answer, which is
   * what made this message shippable at all — decision `D5` deferred it while the only available
   * address was an unverified field on an anonymous form (`#132`). The anonymous door still sends
   * nothing.
   */
  | "proposal.submitted";

/**
 * Which channels each trigger may legitimately use.
 *
 * One table rather than the four hand-written conditionals this replaces, because those had
 * grown into a rule nobody could state: "email requires a template", "email may not be a
 * projection trigger", "a non-email channel requires a projection trigger", "a non-email channel
 * requires a version" — four negatives that between them encoded a mapping, and that could not
 * express a fifth channel without a fifth conditional. Adding a trigger now means adding a row,
 * and a trigger with no row is a compile error rather than a delivery nothing will send.
 *
 * `speaker.calendar_invite` is `email` on purpose: a calendar invitation reaches Gmail, Outlook
 * and Apple Calendar by arriving as mail whose body part is `text/calendar; method=REQUEST`.
 * A separate calendar channel would need a provider with no protocol to speak.
 */
export const TRIGGER_CHANNELS = {
  "speaker.invited": ["email"],
  "reviewer.assigned": ["email"],
  "organizer.digest": ["email"],
  "speaker.scheduled": ["email"],
  "speaker.task_assigned": ["email"],
  "speaker.task_reminder": ["email"],
  "speaker.calendar_invite": ["email"],
  "decision.recorded": ["email"],
  "proposal.submitted": ["email"],
  "projection.requested": ["airtable", "accelevents"],
  "schedule.published": ["event"],
} as const satisfies Record<TriggerType, readonly DeliveryChannel[]>;

/** True when this trigger may be sent over this channel. */
export const triggerAllowsChannel = (trigger: TriggerType, channel: DeliveryChannel): boolean =>
  (TRIGGER_CHANNELS[trigger] as readonly DeliveryChannel[]).includes(channel);

/** The channels whose success updates outbound projection state. Narrows, so callers keep the type. */
export const isProjectionChannel = (
  channel: DeliveryChannel,
): channel is "airtable" | "accelevents" => channel === "airtable" || channel === "accelevents";

/**
 * Triggers a request may name. `schedule.published` is absent, and that is the point.
 *
 * A domain event records that something already happened inside this system. Letting an HTTP
 * caller mint one would let an organizer announce a schedule publication that never occurred,
 * to consumers whose whole reason for trusting the record is that it was committed in the same
 * transaction as the publication itself.
 */
export const REQUESTABLE_TRIGGERS = (Object.keys(TRIGGER_CHANNELS) as TriggerType[]).filter(
  (trigger) =>
    !triggerAllowsChannel(trigger, "event") &&
    /*
     * `proposal.submitted` is the second exclusion, and it is narrower than the domain-event one.
     * A submission confirmation's recipient is resolved from the session that submitted the
     * proposal — that is the whole property that made it shippable (`#132`, decision `D5`) — so a
     * request naming an arbitrary address would hand back exactly the mail primitive the account
     * binding removes. `requestTriggerTypeSchema` in the contracts package states the same
     * exclusion at the HTTP boundary; this keeps the derived set from disagreeing with it, which
     * it silently did until a review pass compared the two.
     */
    trigger !== "proposal.submitted",
);

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
  /**
   * The message as sent, rendered from `templateVersion` against `payload` at enqueue and never
   * re-rendered — a retry three days later sends the text that was composed, not the text the
   * template says today. Null on projection channels, which carry a payload rather than a
   * message, and on any delivery enqueued before migration 1700.
   */
  readonly renderedSubject: string | null;
  readonly renderedBody: string | null;
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
