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
import type {
  CalendarInviteEnqueueRequest,
  CalendarInviteEnqueueResult,
} from "../communications/public";
import { type Actor, CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import { buildSpeakerInvite } from "./calendar-invite";
import type { ContentWorkspaceView } from "./content-service";

/** Refuses rather than sending an invitation nobody could accept. */
export class CalendarOrganizerUnconfiguredError extends Error {}

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
  readonly communications: {
    enqueueCalendarInvite(
      request: CalendarInviteEnqueueRequest,
    ): Promise<CalendarInviteEnqueueResult>;
  };
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
   * One current delivery per speaker/session pair. Communications remembers the schedule and
   * recipient that delivery carried, so running this twice unchanged writes nothing, while every
   * change advances a monotonic `SEQUENCE` — including A -> B -> A and a corrected address.
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
        // The publication version distinguishes A -> unscheduled -> A even when nobody presses
        // Send during the absent interval. Times alone would compare equal to the first A.
        const scheduleRef = `${schedule.revision}|${schedule.startsAt}|${schedule.endsAt}|${schedule.location}`;
        const inviteFor = (sequence: number) =>
          buildSpeakerInvite({
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
        if (!inviteFor(0)) {
          unreachable.push({
            session: session.title,
            reason: "The published start time is not a usable instant",
          });
          continue;
        }
        const delivery = await this.dependencies.communications.enqueueCalendarInvite({
          organizationId: event.organizationId,
          eventId,
          sessionId: session.id,
          speakerProfileId: speaker.id,
          scheduleRef,
          recipientRef: speaker.email,
          deliveryFor: (sequence) => {
            const invite = inviteFor(sequence);
            if (!invite) throw new Error("Calendar invitation became invalid after validation");
            return {
              organizationId: event.organizationId,
              eventId,
              idempotencyKey: `calendar-invite:${session.id}:${speaker.id}:${sequence}`,
              triggerType: "speaker.calendar_invite",
              channel: "email",
              recipientRef: speaker.email,
              templateKey: CALENDAR_INVITE_TEMPLATE_KEY,
              payload: {
                speakerName: speaker.name,
                sessionTitle: session.title,
                eventName: event.name,
                calendarInvite: {
                  method: "REQUEST",
                  filename: "invite.ics",
                  content: invite.ics,
                },
              },
            };
          },
        });
        if (delivery.created) sent += 1;
        else alreadySent += 1;
      }
    }
    return { sent, alreadySent, unreachable };
  }
}
