/**
 * How content asks for a speaker to be reminded about work they owe.
 *
 * Content owns this interface and holds no import of communications, the same inversion the
 * CRM's `OutreachDispatchPort` and `SpeakerConversionPort` already use. The composition root
 * binds it to the delivering domain's `enqueue` (`ARC-DOM-001`).
 *
 * ## The occurrence is the deadline, and that is the whole design
 *
 * A reminder is idempotent on its key, so what the key names decides how often a speaker is
 * written to. The cron path keyed on `task-reminder:{taskId}:d{offsetDays}` — one reminder per
 * task per *offset* — which had two consequences worth naming, because both are why this now
 * keys on the due date instead:
 *
 * - Changing `offsetDays` changed the key, so every task already reminded about was reminded
 *   again under the new offset. The old module's own header records this as a known wart.
 * - An organizer extending one speaker's deadline could not chase them again, because the key
 *   did not move when the deadline did. #189 asks for the opposite: "reminders and inbox
 *   occurrence keys follow the new deadline".
 *
 * Keying on `dueAt` fixes both, and it makes the automatic reminder and an organizer's
 * deliberate chase converge on one delivery per (task, deadline) rather than sending twice for
 * the same fact. That is what "once per occurrence" means here.
 *
 * @spec PRD-SPK-002 PRD-COM-001 ARC-DOM-001
 */

/** The template a reminder renders from. Seeded; an organizer may publish new versions. */
export const SPEAKER_REMINDER_TEMPLATE_KEY = "speaker-task-reminder";

/** The template a portal invitation renders from — the same one acceptance's welcome uses. */
export const SPEAKER_INVITE_TEMPLATE_KEY = "speaker-invite";

/**
 * The delivery key for one portal invitation to one speaker, at one occurrence.
 *
 * ## Why the occurrence is here at all
 *
 * Acceptance's welcome is keyed `speaker-invite:{eventId}:{profileId}` and that key never moves,
 * so every later invitation to the same person deduplicates into it and nothing is sent. That is
 * the deduplication working correctly on a key that describes the *person* rather than the
 * *act*: a speaker who lost the mail could never be invited again by anybody (#189).
 *
 * `occurrence` is the profile's `invitations_sent` after the claim that produced it (`1408`),
 * which is the same shape `taskReminderKey` gets from `dueAt` and `decision:…:r{revision}` gets
 * from a decision's revision — the key names the thing that happened, and a new one happens only
 * when somebody deliberately makes it happen.
 *
 * ## What converges, and what deliberately does not
 *
 * Convergence here is **per occurrence**, and that is the whole guarantee: the delivering domain
 * is idempotent on this key, so an enqueue content retries — a lost response, the same speaker
 * named twice in one request, a claim handed to a second attempt — writes one message and reports
 * `already-sent` rather than mailing the speaker twice.
 *
 * A *new claim* is a new occurrence and therefore a new delivery, which is exactly what an
 * organizer pressing Invite again means. The residual case is honest and worth naming: a client
 * that re-POSTs the invite command without having seen the first response claims a second
 * occurrence and sends a second invitation, because nothing in that request distinguishes it from
 * the deliberate re-invite it is identical to. That is the deliberate trade — a duplicate
 * invitation is a nuisance an organizer can explain, whereas a speaker who can never be re-invited
 * is a person locked out of the portal. Closing it needs a caller-supplied command key, the shape
 * `1600` uses for agenda publication, which is a request-shape change rather than a storage one.
 *
 * The acceptance welcome keeps its unnumbered key, so it is not occurrence 1 and an explicit
 * invitation never converges into it. The two are different acts — "your talk is in" and "here is
 * your portal again" — and the delivery history shows both.
 */
export const speakerInvitationKey = (eventId: string, profileId: string, occurrence: number) =>
  `speaker-invite:${eventId}:${profileId}:n${occurrence}`;

/**
 * The delivery key for one reminder about one task at one deadline.
 *
 * Shared by the cron sweep and the organizer's own send, so the two cannot disagree about
 * whether a speaker has already been told. `dueAt` is used as stored rather than reformatted:
 * two spellings of the same instant would be two keys, and the value only ever arrives from the
 * row itself.
 */
export const taskReminderKey = (taskId: string, dueAt: string) =>
  `task-reminder:${taskId}:${dueAt}`;

export interface SpeakerReminder {
  readonly organizationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly recipientRef: string;
  readonly templateKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SpeakerReminderDelivery {
  readonly deliveryId: string;
  /**
   * False when this key already had a delivery and nothing new was written.
   *
   * Load-bearing rather than informational: an organizer pressing Remind on a task the sweep
   * already covered must be told the speaker has already been reminded, not that a message was
   * queued that was not.
   */
  readonly created: boolean;
}

/**
 * One portal invitation, addressed and keyed by content.
 *
 * Structurally identical to `SpeakerReminder`, and separate on purpose — see the port below.
 */
export interface SpeakerPortalInvitation {
  readonly organizationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly recipientRef: string;
  readonly templateKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * How content asks for one of the two things it writes to a speaker about.
 *
 * **A second method rather than a generalised `send`**, and the reason is the one thing the two
 * messages do not share. A reminder and an invitation already agree about everything this
 * interface carries — the key is content's, the template is content's, the payload is content's —
 * so a single `send` would look like the simplification. What differs is the *trigger* the
 * delivering domain files the delivery under: `speaker.task_reminder` against
 * `speaker.invited`. One method would mean either mislabelling invitations as reminders in the
 * delivery log — where an operator answering "what have we sent this person?" reads it — or
 * putting the delivering domain's trigger taxonomy into content's own message shape, which is the
 * import this port exists to avoid (`ARC-DOM-001`). Two methods let the composition root keep that
 * vocabulary, which is where it belongs, and cost one line of interface to do it.
 */
export interface SpeakerReminderDispatchPort {
  send(reminder: SpeakerReminder): Promise<SpeakerReminderDelivery>;
  /**
   * Queue a portal invitation, or converge on the one this occurrence already had.
   *
   * Answers with `created: false` when the key already had a delivery, for the same reason
   * `send` does: an organizer must be told the speaker has already been invited rather than that
   * a message was queued that was not.
   */
  invite(invitation: SpeakerPortalInvitation): Promise<SpeakerReminderDelivery>;
}

/**
 * Raised when the delivering domain refuses a reminder as described — an unknown template, or a
 * request it considers incoherent. A content error class on purpose: converting the other
 * domain's exceptions belongs to the adapter that binds this port.
 */
export class SpeakerReminderRejectedError extends Error {}
