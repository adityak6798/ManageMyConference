/**
 * Telling somebody a CFP deadline is coming, and telling the organizer when it has gone.
 *
 * Issue #210, and the first residual of `GAP-027`. The submission window shipped in #190 with
 * `opens_at`, `closes_at`, enforcement at the application boundary and the date on both surfaces —
 * and nothing that announced it. An organizer who set a deadline weeks earlier discovered the call
 * had closed from a quiet inbox; a submitter holding an unsubmitted draft was never told it was
 * about to become unsubmittable, on a surface whose whole promise is that a draft survives a
 * closed browser (`PRD-CFP-004`).
 *
 * ## The three decisions the issue said had to be made rather than defaulted
 *
 * **Which trigger.** Two new `trigger_type` values, `cfp.deadline_approaching` and
 * `cfp.call_closed` (migration `1707`). They are two different facts and `trigger_type` is what
 * the history, the webhook fan-out and the schedule-mail consumer read to decide what a row *is*,
 * so neither is folded into `proposal.submitted`. Both are excluded from `REQUESTABLE_TRIGGERS`:
 * an organizer cannot author one at an address of their choosing.
 *
 * **Whose cadence.** One message each, and the two audiences are timed opposite ways round.
 *
 *   - A **draft holder** is reminded once, inside `REMINDER_LEAD_HOURS` *before* the deadline.
 *     Once, not a series: the draft is theirs, it is on a page that states the deadline, and a
 *     second message is nagging somebody who may have decided against submitting. Relative to the
 *     deadline rather than to the draft's last edit, because the deadline is the thing that is
 *     about to make it unsubmittable and a draft edited this morning is in exactly as much danger
 *     as one edited in March.
 *   - An **organizer** is told once, *after* the deadline, that the call has closed. Before-the-
 *     deadline reminders to organizers were considered and dropped: an organizer is not at risk of
 *     losing work, and what they actually need is to know the queue is now final so they can start
 *     reviewing. `CLOSED_LOOKBACK_HOURS` bounds how far back this reaches, so the first tick after
 *     a deploy announces the last day's closures rather than every call that ever closed.
 *
 * **Whether a draft holder consented to be reminded.** They were never asked, and this decides
 * that they do not need to be. The reasoning, recorded in `PRD-CFP-003` rather than only here: the
 * message is about the applicant's **own** unsubmitted draft, on the event they created it on,
 * addressed to the account address identity already holds — the same address that already received
 * their submission confirmation, which is what established the channel. It is sent at most once per
 * deadline, and it says in its own words that nothing further will be sent. That is a transactional
 * message about a thing the recipient is in the middle of, not a message about anything else, and
 * there is no second use for the address. A decline control is the alternative and remains
 * available if that judgement is ever wrong; what would be wrong is to send *and* leave them no
 * statement of it, which is why the wording carries the promise.
 *
 * ## The idempotency key is the whole design, again
 *
 * The cron fires every sixty seconds. `task-reminders.ts` states the rule this follows: there is
 * no bookkeeping table and no "last reminded at" column, because a crash between deciding and
 * recording would double-send whatever the control flow looked like. The key **is** the record,
 * and the unique index on `(organization_id, idempotency_key)` is what makes the second tick a
 * no-op.
 *
 * The occurrence in the key is the **deadline instant**, not the day it ran. So an organizer who
 * moves a deadline gets a new occurrence — which is right, because a new deadline is a new fact —
 * and a scheduler that ran a thousand times against an unchanged one sends exactly one message.
 *
 * @spec PRD-COM-001 PRD-CFP-003
 */
import type { CommunicationsCfpQuery } from "../cfp/public";
import { CommunicationsInputError, CommunicationsNotFoundError } from "./errors";
import type { CommunicationsEnqueue } from "./public";

/** The template each message renders from. Provisioned as a default; an organizer may edit it. */
export const DRAFT_REMINDER_TEMPLATE_KEY = "cfp-deadline-reminder";
export const CALL_CLOSED_TEMPLATE_KEY = "cfp-call-closed";

/**
 * How long before a deadline a draft holder is reminded.
 *
 * Forty-eight hours: long enough to be actionable for somebody who has to finish writing, short
 * enough that "closes soon" is true. Changing it changes nothing about who has already been
 * reminded — the key names the deadline, not the offset — so a shortened lead simply stops
 * catching calls it no longer reaches.
 */
export const REMINDER_LEAD_HOURS = 48;

/**
 * How long after a deadline the closing notice is still worth sending.
 *
 * Bounded so the first tick after this ships does not announce every call that has ever closed.
 * Twenty-four hours is comfortably more than the cron's own reliability and less than the point
 * at which "your call has closed" stops being news.
 */
export const CLOSED_LOOKBACK_HOURS = 24;

/** The most calls one tick will consider, for the reason `REMINDER_BATCH_LIMIT` gives. */
export const DEADLINE_BATCH_LIMIT = 50;

const HOUR_MS = 60 * 60 * 1000;

/** One person a message can be addressed to, answered by identity from an account id. */
export interface DeadlineRecipient {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

export interface CfpDeadlineDependencies {
  readonly calls: CommunicationsCfpQuery;
  readonly enqueue: CommunicationsEnqueue;
  /**
   * The owning organization, the event's name and its timezone. Events owns all three; this asks
   * rather than joins, exactly as the task reminder asks for `organizationOf`.
   */
  readonly eventOf: (
    eventId: string,
  ) => Promise<{ organizationId: string; name: string; timezone: string } | null>;
  /** One account's display name and address. Null address means unreachable, never a guess. */
  readonly findRecipient: (userId: string) => Promise<DeadlineRecipient | null>;
  /** The organizers of one event, to tell that it has closed. */
  readonly organizersOf: (eventId: string) => Promise<readonly DeadlineRecipient[]>;
  readonly now: () => Date;
  readonly leadHours?: number;
  readonly lookbackHours?: number;
  readonly limit?: number;
  /** Reports a message that could not be queued. Never called for an ordinary duplicate. */
  readonly onFailure?: (fields: Record<string, unknown>) => void;
}

export interface CfpDeadlineResult {
  /** Calls inside the window this tick, whether or not anything was sent about them. */
  readonly considered: number;
  /** Reminders written this tick. Zero on every tick after the first, which is correct. */
  readonly reminded: number;
  /** Closing notices written this tick. */
  readonly announced: number;
}

/**
 * The deadline as a person reads it, in the event's own timezone.
 *
 * Never in the server's and never in UTC-with-a-Z: a deadline is a wall-clock promise the
 * organizer made on a public page, and a message that restates it in a different zone is telling
 * the applicant a different deadline. The zone abbreviation is included for the same reason the
 * public page includes it.
 */
export const deadlineInZone = (instant: string, timeZone: string): string => {
  try {
    // Explicit components rather than `dateStyle`/`timeStyle`: `Intl` refuses either of those
    // alongside `timeZoneName` with a bare `Invalid option : option`, and the abbreviation is the
    // part an applicant in another country actually needs.
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(instant));
  } catch {
    // ERROR-INTENT: an unusable zone must not stop the message — the applicant still needs to be
    // told the call is closing. The instant itself is unambiguous, if uglier, so it is what a
    // message falls back to rather than nothing.
    return instant;
  }
};

/**
 * Queue one reminder per draft holder about to lose their chance, and one notice per organizer
 * whose call has just closed.
 *
 * Never throws, for the reason `enqueueDueTaskReminders` gives: it runs from `scheduled()`
 * alongside the outbox drain, and one broken template must not leave every queued delivery unsent.
 */
export async function enqueueCfpDeadlineNotices(
  dependencies: CfpDeadlineDependencies,
): Promise<CfpDeadlineResult> {
  const now = dependencies.now();
  const leadHours = dependencies.leadHours ?? REMINDER_LEAD_HOURS;
  const lookbackHours = dependencies.lookbackHours ?? CLOSED_LOOKBACK_HOURS;
  const from = new Date(now.getTime() - lookbackHours * HOUR_MS).toISOString();
  const to = new Date(now.getTime() + leadHours * HOUR_MS).toISOString();
  let calls: Awaited<ReturnType<CommunicationsCfpQuery["listDeadlineNotices"]>>;
  try {
    calls = await dependencies.calls.listDeadlineNotices(
      { from, to },
      dependencies.limit ?? DEADLINE_BATCH_LIMIT,
    );
  } catch (error) {
    // ERROR-INTENT: reported and the tick continues, so a storage failure reading calls cannot
    // take the outbox drain down with it. Nothing durable was written, so the next tick retries.
    dependencies.onFailure?.({
      reason: "closing calls could not be read",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { considered: 0, reminded: 0, announced: 0 };
  }

  const nowInstant = now.toISOString();
  let reminded = 0;
  let announced = 0;
  for (const call of calls) {
    try {
      const event = await dependencies.eventOf(call.eventId);
      if (!event) {
        dependencies.onFailure?.({ eventId: call.eventId, reason: "no owning organization" });
        continue;
      }
      const closesAt = deadlineInZone(call.closesAt, event.timezone);
      // Which side of the deadline this call is on decides which message it gets, and it is asked
      // per call rather than per window: one read spans both sides, so a tick can carry a call
      // that closed an hour ago beside one closing tomorrow.
      const closed = call.closesAt <= nowInstant;
      const audience = closed
        ? (await dependencies.organizersOf(call.eventId)).map((organizer) => ({
            recipient: organizer,
            key: `cfp-call-closed:${call.eventId}:${organizer.id}:${call.closesAt}`,
            triggerType: "cfp.call_closed" as const,
            templateKey: CALL_CLOSED_TEMPLATE_KEY,
            payload: { organizerName: organizer.name, eventName: event.name, closesAt },
          }))
        : await Promise.all(
            call.draftHolders.map(async (holder) => {
              const recipient = await dependencies.findRecipient(holder.userId);
              return {
                recipient,
                key: `cfp-deadline:${call.eventId}:${holder.userId}:${call.closesAt}`,
                triggerType: "cfp.deadline_approaching" as const,
                templateKey: DRAFT_REMINDER_TEMPLATE_KEY,
                payload: {
                  submitterName: recipient?.name ?? "",
                  eventName: event.name,
                  closesAt,
                  draftCount:
                    holder.draftCount === 1 ? "one proposal" : `${holder.draftCount} proposals`,
                },
              };
            }),
          );

      for (const message of audience) {
        // No address means unreachable, and that is reported rather than guessed at: an account
        // identity holds no address for cannot be written to, and a delivery to an empty string
        // would burn three attempts reaching nobody.
        if (!message.recipient?.email) {
          dependencies.onFailure?.({
            eventId: call.eventId,
            userId: message.recipient?.id ?? null,
            reason: "no address for this account",
          });
          continue;
        }
        const delivery = await dependencies.enqueue.enqueue({
          organizationId: event.organizationId,
          eventId: call.eventId,
          idempotencyKey: message.key,
          triggerType: message.triggerType,
          channel: "email",
          recipientRef: message.recipient.email,
          payload: message.payload,
          templateKey: message.templateKey,
        });
        if (delivery.created) {
          if (closed) announced += 1;
          else reminded += 1;
        }
      }
    } catch (error) {
      // ERROR-INTENT: one call's messages failing — a missing template, a payload the template
      // cannot fill — must not stop the others or the drain that follows. Reported with the ids
      // needed to act on it; the next tick retries, because nothing durable was written.
      dependencies.onFailure?.({
        eventId: call.eventId,
        reason:
          error instanceof CommunicationsNotFoundError || error instanceof CommunicationsInputError
            ? error.message
            : "unexpected failure",
      });
    }
  }
  return { considered: calls.length, reminded, announced };
}
