/**
 * What happens when an `EVT-SCHEDULE-PUBLISHED` record reaches the front of the outbox.
 *
 * The agenda commits the record inside the same D1 batch as the publication it announces, so by
 * the time this runs the schedule is durably published and cannot be un-published underneath the
 * messages. This turns that one record into one email per speaker on the event.
 *
 * ## Why the fan-out is here and not at publication time
 *
 * The obvious alternative — have agenda enqueue N speaker emails directly when it publishes — is
 * wrong twice. It puts an unbounded amount of work inside the transaction that must commit for
 * the publication to exist, so a large event makes publishing slower and more likely to fail at
 * exactly the moment it matters. And it makes agenda responsible for knowing who the speakers
 * are and what they should be told, which is this domain's job.
 *
 * One durable record commits with the publication; the fan-out happens afterwards, on the
 * outbox's own schedule, and is retried by the outbox's own machinery if it fails halfway.
 *
 * ## Why running twice is safe
 *
 * The outbox is at-least-once: a lease that expires mid-fan-out, a worker that dies after
 * enqueueing three of five, or a retried publish command all lead here more than once. Every
 * enqueue is keyed `schedule:{eventId}:v{version}:{userId}`, so a second pass returns the
 * deliveries the first pass wrote instead of sending anybody a duplicate. That is what lets a
 * partial failure simply be retried rather than reconciled.
 *
 * @spec PRD-COM-001 PRD-INT-001 ARC-FLOW-002
 */
import type { Delivery } from "../../domain/communications/delivery";
import type { IdentityDirectory } from "../identity/identity-directory";
import { CommunicationsInputError, CommunicationsNotFoundError } from "./errors";
import type { DomainEventConsumer, ProviderResult } from "./ports";
import type { CommunicationsEnqueue } from "./public";

/** The template a schedule confirmation renders from. Seeded; an organizer may publish new versions. */
export const SCHEDULE_TEMPLATE_KEY = "schedule-published";

export interface SchedulePublishedConsumerDependencies {
  readonly enqueue: CommunicationsEnqueue;
  /** Who the event's speakers are. Identity's answer; this domain reads no roles table. */
  readonly speakerDirectory: Pick<IdentityDirectory, "listSpeakersForEvent">;
  /**
   * Where a speaker downloads their own calendar file.
   *
   * Injected rather than built here because the origin belongs to the deployment, not to this
   * domain, and a message containing `undefined/api/...` is worse than one containing no link.
   */
  readonly calendarUrl: (eventId: string) => string;
  readonly templateKey?: string;
}

/** The publication version this record announces, or null if the payload does not carry one. */
const publicationVersionOf = (delivery: Delivery): number | null => {
  const value = delivery.payload.publicationVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
};

export class SchedulePublishedConsumer implements DomainEventConsumer {
  constructor(private readonly dependencies: SchedulePublishedConsumerDependencies) {}

  async consume(delivery: Delivery): Promise<ProviderResult> {
    if (delivery.triggerType !== "schedule.published")
      // Not retryable: nothing about waiting makes an unrecognised event consumable, and leaving
      // it queued would hide it. Terminal keeps it visible in the history with a code that says
      // what happened.
      return { kind: "terminal", code: "UNSUPPORTED_DOMAIN_EVENT" };
    const version = publicationVersionOf(delivery);
    if (version === null) return { kind: "terminal", code: "EVENT_PAYLOAD_INVALID" };

    const speakers = await this.dependencies.speakerDirectory.listSpeakersForEvent(
      delivery.eventId,
    );
    const reachable = speakers.filter(
      (speaker): speaker is { id: string; name: string; email: string } => speaker.email !== null,
    );

    let enqueued = 0;
    for (const speaker of reachable) {
      try {
        const result = await this.dependencies.enqueue.enqueue({
          organizationId: delivery.organizationId,
          eventId: delivery.eventId,
          idempotencyKey: `schedule:${delivery.eventId}:v${version}:${speaker.id}`,
          triggerType: "speaker.scheduled",
          channel: "email",
          recipientRef: speaker.email,
          payload: {
            speakerName: speaker.name,
            publicationVersion: version,
            calendarUrl: this.dependencies.calendarUrl(delivery.eventId),
          },
          templateKey: this.dependencies.templateKey ?? SCHEDULE_TEMPLATE_KEY,
        });
        if (result.created) enqueued += 1;
      } catch (error) {
        // ERROR-INTENT: a missing or incoherent template is a configuration fault that repeating
        // the fan-out cannot fix, so it fails terminally with a code an organizer can act on
        // rather than burning three attempts. Anything else — a storage failure mid-fan-out — is
        // genuinely transient, and the idempotency keys make the retry safe: speakers already
        // enqueued are returned rather than re-sent.
        if (error instanceof CommunicationsNotFoundError)
          return { kind: "terminal", code: "SCHEDULE_TEMPLATE_MISSING" };
        if (error instanceof CommunicationsInputError)
          return { kind: "terminal", code: "SCHEDULE_TEMPLATE_UNRENDERABLE" };
        throw error;
      }
    }
    // The reference records what this consumption did, not what the whole event amounts to: on a
    // retry after a partial pass the count is the remainder, and the attempt history holds both.
    return {
      kind: "success",
      providerReference: `schedule:v${version}:enqueued=${enqueued}:reachable=${reachable.length}`,
    };
  }
}
