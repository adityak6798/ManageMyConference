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
import {
  CommunicationsInputError,
  CommunicationsNotFoundError,
  UnverifiedRecipientCapError,
} from "./errors";
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

/**
 * The most **recipients** one tick will resolve and enqueue for, across every call it considers.
 *
 * `DEADLINE_BATCH_LIMIT` bounds the calls; nothing bounded the people, and the two are not the
 * same unit. One popular call with five hundred unsubmitted drafts meant five hundred concurrent
 * identity reads plus five hundred idempotency reads — *every sixty seconds for the whole
 * forty-eight-hour lead window*, because the key is checked per holder rather than the window
 * being marked done. `scheduled()` awaits this pass before `drainOutbox`, so a tick that exhausts
 * its subrequest budget here delays every queued delivery, including the ones this pass just
 * wrote. `task-reminders.ts` bounds the unit it iterates for exactly this reason.
 *
 * Nothing is lost when the bound bites: the holders it did not reach still hold drafts and the
 * deadline has not moved, so the next tick sees them. It is a rate limit on a backlog, not a
 * ceiling on who is told.
 */
export const DEADLINE_RECIPIENT_LIMIT = 200;

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
   * Whether this key already has a delivery — one indexed read, and no identity lookup.
   *
   * The cheap half of the tick. Without it every holder costs an address resolution on every
   * sixty-second tick for the whole lead window, when the answer after the first tick is always
   * "already told". Asking first turns the steady state into one key read per holder and keeps the
   * expensive work for the people who have not been written to yet.
   */
  readonly alreadyEnqueued: (organizationId: string, idempotencyKey: string) => Promise<boolean>;
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
  readonly recipientLimit?: number;
  /** Reports a message that could not be queued. Never called for an ordinary duplicate. */
  readonly onFailure?: (fields: Record<string, unknown>) => void;
}

export interface CfpDeadlineResult {
  /**
   * Calls this tick actually looked at.
   *
   * Not "calls inside the window": the recipient budget stops the loop, so a tick that ran out of
   * budget reports fewer than the read returned and the next tick continues from there. Reading it
   * as a window count would make a busy hour look like a shrinking one.
   */
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
 * The draft holders on this call who have not been written to yet, up to `budget`.
 *
 * Asked with the cheap key read rather than by resolving everybody and letting the enqueue
 * converge: convergence is correct but costs an identity lookup per holder per tick, and this pass
 * runs every sixty seconds for the whole lead window. It is also what makes the recipient budget
 * advance — a budget spent on people who were already told would stop the tick at the same
 * holders for ever, and the rest of the call would never be reached.
 *
 * **The starting point rotates, and that is not decoration.** A holder whose account holds no
 * address never gets a delivery row, so `alreadyEnqueued` says "no" about them on every tick for
 * ever. Reading in list order therefore lets a run of unreachable accounts at the front of a call
 * hold the whole budget permanently, and every holder behind them — and every call after this one
 * — is never reached at all. The offset is the hour, so it is stable within a tick and across the
 * retries of one. Stated exactly rather than generously: it advances one position per hour, so an
 * event needs more unreachable holders at the front than the lead window has hours before anybody
 * reachable is missed — with today's constants, over two hundred of them. That is a bound rather
 * than a guarantee, and it is the honest one. Nothing here decides *whether* a message is sent,
 * only in which order candidates are considered, so a rotation cannot send twice: the key is what
 * prevents that.
 */
async function pendingHolders(
  dependencies: CfpDeadlineDependencies,
  organizationId: string,
  call: {
    readonly eventId: string;
    readonly closesAt: string;
    readonly draftHolders: readonly { readonly userId: string; readonly draftCount: number }[];
  },
  budget: number,
  now: Date,
): Promise<readonly { readonly userId: string; readonly draftCount: number }[]> {
  const holders = call.draftHolders;
  const pending: { readonly userId: string; readonly draftCount: number }[] = [];
  if (holders.length === 0) return pending;
  const offset = Math.floor(now.getTime() / 3_600_000) % holders.length;
  for (let step = 0; step < holders.length; step += 1) {
    if (pending.length >= budget) break;
    const holder = holders[(offset + step) % holders.length] as (typeof holders)[number];
    const key = `cfp-deadline:${call.eventId}:${holder.userId}:${call.closesAt}`;
    if (!(await dependencies.alreadyEnqueued(organizationId, key))) pending.push(holder);
  }
  return pending;
}

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
  const recipientLimit = dependencies.recipientLimit ?? DEADLINE_RECIPIENT_LIMIT;
  let considered = 0;
  let resolved = 0;
  let reminded = 0;
  let announced = 0;
  for (const call of calls) {
    // The recipient budget is spent across calls, not per call, and it stops the loop rather than
    // truncating one call's audience — a half-told event would leave the rest of its holders
    // waiting on a tick that had already counted the call as considered.
    if (resolved >= recipientLimit) break;
    considered += 1;
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
            (
              await pendingHolders(
                dependencies,
                event.organizationId,
                call,
                recipientLimit - resolved,
                now,
              )
            ).map(async (holder) => {
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

      resolved += audience.length;
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
          error instanceof CommunicationsNotFoundError ||
          error instanceof CommunicationsInputError ||
          // A reached cap is a decision this scheduler made, not a fault: reporting it as
          // "unexpected failure" hides the one line an operator needs to understand the silence.
          error instanceof UnverifiedRecipientCapError
            ? error.message
            : "unexpected failure",
      });
    }
  }
  // `considered` counts the calls this tick actually worked, which is what the recipient budget
  // can cut short — reporting `calls.length` would claim work the budget stopped.
  return { considered, reminded, announced };
}
