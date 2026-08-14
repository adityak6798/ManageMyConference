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

export interface SpeakerReminderDispatchPort {
  send(reminder: SpeakerReminder): Promise<SpeakerReminderDelivery>;
}

/**
 * Raised when the delivering domain refuses a reminder as described — an unknown template, or a
 * request it considers incoherent. A content error class on purpose: converting the other
 * domain's exceptions belongs to the adapter that binds this port.
 */
export class SpeakerReminderRejectedError extends Error {}
