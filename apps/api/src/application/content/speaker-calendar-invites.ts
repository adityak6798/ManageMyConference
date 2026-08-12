/*
 * Sending a speaker the invitation for their own session.
 *
 * The download at `/api/events/{id}/speaker-calendar.ics` has always required the speaker to go
 * and fetch it. This is the other direction — the organizer sends, and the invitation arrives in
 * the speaker's mail and lands on their calendar with an Accept/Decline card (`PRD-SPK-002`,
 * brief feature 3).
 *
 * It sits in `content` because content owns the session and speaker data and generates the
 * calendar payload; delivery is handed to communications through its declared public interface,
 * which is the only thing this module knows about that domain. Communications never reads a
 * content table and never builds an ICS.
 *
 * @spec PRD-SPK-002 PRD-COM-001 PORT-CALENDAR
 */
import type { DeliveryRequest, EnqueuedDelivery } from "../communications/public";
import { type Actor, CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import { buildSpeakerInvite } from "./calendar-invite";
import type { ContentWorkspaceView } from "./content-service";

/** Refuses rather than sending an invitation nobody could accept. */
export class CalendarOrganizerUnconfiguredError extends Error {}

/**
 * `SEQUENCE` has to increase when a session moves, and nothing in the schedule carries a version.
 *
 * RFC 5546 section 2.1.4: a client applies a `REQUEST` for a `UID` it already holds only when the
 * `SEQUENCE` is higher than the one it has. A hash of the schedule would be different but not
 * ordered, so a rescheduled session could arrive with a lower number and be silently ignored,
 * leaving the speaker's calendar on the old time — the exact failure this feature exists to
 * prevent.
 *
 * Seconds since 2026-01-01 is monotonic by construction, is stable for a whole send, and stays
 * far inside the signed 32-bit range an iCalendar INTEGER is read as: it reaches ~2^31 in the
 * 2090s, where epoch seconds would overflow in 2038.
 *
 * Retries do not disturb it. A resend of an unchanged schedule reuses the idempotency key below
 * and creates no delivery at all, so the only invitations that carry a new sequence are the ones
 * describing a genuinely new time.
 *
 * **Where a clock is not good enough, stated rather than hidden.** Whole-second resolution means
 * two invitations for the same session and speaker issued inside one second carry the *same*
 * sequence, and RFC 5546 says a client applies an update only on a strictly higher one — so the
 * second would be ignored and the calendar would keep the first time. Reaching it needs a session
 * moved twice within a second, or two organizers sending concurrently. Finer resolution does not
 * fix it: milliseconds since the same epoch overflow a 32-bit integer in under a month.
 *
 * The real fix is the same one issue **#136** describes for the idempotency key — a sequence that
 * counts what has actually been sent to this speaker for this session, rather than reading a
 * clock and hoping. Both need per-pair state this feature does not keep, so they are one problem
 * and are tracked as one.
 */
const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
const sequenceFor = (now: Date) =>
  Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH_MS) / 1000));

export interface SpeakerCalendarInviteResult {
  /** Invitations written to the outbox by this call. */
  readonly sent: number;
  /** Already sent for this exact schedule, so nothing was written. */
  readonly alreadySent: number;
  /**
   * Who could not be invited and why, named rather than counted.
   *
   * A send that silently reaches fewer people than the organizer thinks is the failure worth
   * designing against: they need the names to chase, not a smaller number.
   */
  readonly unreachable: readonly { readonly session: string; readonly reason: string }[];
}

/*
 * Each dependency is the one method this module calls, not the service that implements it.
 *
 * The composition root passes `ContentService`, `CommunicationsService` and `EventService`, which
 * satisfy these structurally. Naming the method rather than the class states the coupling exactly
 * — this module reads a workspace and enqueues a delivery, and cannot reach anything else.
 */
export interface SpeakerCalendarInviteDependencies {
  readonly content: {
    workspace(actor: Actor | null, eventId: string): Promise<ContentWorkspaceView>;
  };
  readonly communications: { enqueue(request: DeliveryRequest): Promise<EnqueuedDelivery> };
  /**
   * The event's name and owning organization — the two facts an invitation needs.
   *
   * Spelled out rather than imported from the events domain: this module needs a name and an
   * organization id, not `Event`, and stating that keeps content from depending on the shape of
   * another domain's record. `EventService.get` satisfies it structurally.
   */
  readonly events: {
    get(
      actor: Actor | null,
      eventId: string,
    ): Promise<{
      readonly id: string;
      readonly organizationId: string;
      readonly name: string;
    } | null>;
  };
  /**
   * The address invitations come from, and the `ORGANIZER` of every one of them.
   *
   * Absent means unconfigured, and unconfigured means refuse — see `send`. Resolved from
   * `EMAIL_SENDER`, which is the address the mail provider has authorized for this domain.
   */
  readonly organizerEmail?: string | undefined;
  readonly now: () => Date;
}

/** The template an invitation's covering message is rendered from. Seeded; organizer-editable. */
export const CALENDAR_INVITE_TEMPLATE_KEY = "speaker-calendar-invite";

export class SpeakerCalendarInviteService {
  constructor(private readonly dependencies: SpeakerCalendarInviteDependencies) {}

  /**
   * Invite every speaker of every scheduled session on this event.
   *
   * One delivery per speaker per session per schedule. The idempotency key carries the times and
   * location, so running this twice on an unchanged agenda writes nothing the second time, and a
   * session that has moved produces exactly one new invitation carrying a higher `SEQUENCE` —
   * which is what makes a client replace the entry instead of adding a second one.
   */
  async send(actor: Actor | null, eventId: string): Promise<SpeakerCalendarInviteResult> {
    const authorized = requireEventCapability(actor, eventId, "content:manage");
    const organizerEmail = this.dependencies.organizerEmail;
    // Refused, never defaulted. Gmail and Outlook check that ORGANIZER corresponds to the sending
    // identity before offering Accept/Decline, so an invented address produces an invitation that
    // looks delivered and does nothing — worse than the refusal, because nobody finds out.
    if (!organizerEmail)
      throw new CalendarOrganizerUnconfiguredError(
        "Calendar invitations require the EMAIL_SENDER binding: it becomes the ORGANIZER of every " +
          "invitation, and a calendar client refuses one whose organizer is not the sender.",
      );
    const event = await this.dependencies.events.get(authorized, eventId);
    if (!event) throw new CapabilityDeniedError("Event not found");

    const workspace = await this.dependencies.content.workspace(authorized, eventId);
    const profiles = new Map(workspace.speakers.map((speaker) => [speaker.id, speaker]));
    const stamp = this.dependencies.now();
    const sequence = sequenceFor(stamp);
    const unreachable: { session: string; reason: string }[] = [];
    let sent = 0;
    let alreadySent = 0;

    for (const session of workspace.sessions) {
      const schedule = session.schedule;
      // An unscheduled session has no time to invite anyone to. Not a failure and not reported as
      // one — the organizer has simply not placed it yet.
      if (!schedule) continue;
      for (const profileId of session.speakerProfileIds) {
        const speaker = profiles.get(profileId);
        if (!speaker?.email) {
          unreachable.push({
            session: session.title,
            reason: speaker
              ? `${speaker.name} has no email address on their speaker profile`
              : "A speaker on this session has no profile in this workspace",
          });
          continue;
        }
        const invite = buildSpeakerInvite({
          event: { id: event.id, name: event.name },
          organizer: { name: event.name, email: organizerEmail },
          speaker: { name: speaker.name, email: speaker.email },
          session: {
            id: session.id,
            title: session.title,
            startsAt: schedule.startsAt,
            endsAt: schedule.endsAt,
            location: schedule.location,
          },
          sequence,
          stamp,
        });
        if (!invite) {
          unreachable.push({
            session: session.title,
            reason: "The published start time is not a usable instant",
          });
          continue;
        }
        // The schedule is *in* the key, which is what makes this idempotent in the way that
        // matters: the same agenda sends once however often the organizer presses the button,
        // and a moved session is a different key rather than a suppressed duplicate.
        const scheduleRef = `${schedule.startsAt}|${schedule.endsAt}|${schedule.location}`;
        const delivery = await this.dependencies.communications.enqueue({
          organizationId: event.organizationId,
          eventId,
          idempotencyKey: `calendar-invite:${session.id}:${speaker.id}:${scheduleRef}`,
          triggerType: "speaker.calendar_invite",
          channel: "email",
          recipientRef: speaker.email,
          templateKey: CALENDAR_INVITE_TEMPLATE_KEY,
          payload: {
            speakerName: speaker.name,
            sessionTitle: session.title,
            eventName: event.name,
            // What the email adapter turns into a `text/calendar; method=REQUEST` part. Stored
            // with the delivery, so a retry three days later sends the invitation that was
            // composed rather than one rebuilt from an agenda that has since moved.
            calendarInvite: { method: "REQUEST", filename: "invite.ics", content: invite.ics },
          },
        });
        if (delivery.created) sent += 1;
        else alreadySent += 1;
      }
    }
    return { sent, alreadySent, unreachable };
  }
}
