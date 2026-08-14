/**
 * Reminding a speaker about work that is about to be late, from the one-minute cron tick.
 *
 * The last of issue #52's scope bullets. It needed content's open-task data, which was declared
 * as `CommunicationsContentQuery` and had no implementation until now.
 *
 * ## The whole design is the idempotency key
 *
 * The cron fires every sixty seconds. Anything here that is not idempotent mails a speaker
 * fourteen hundred times a day, and no amount of care in this file's control flow would fix
 * that — a crash between "decide to remind" and "record that we did" would still double-send.
 * So there is no bookkeeping table and no "last reminded at" column. The key
 * `task-reminder:{taskId}:{dueAt}` *is* the record: the second tick prepares the same key,
 * the unique index on `(organization_id, idempotency_key)` returns the first delivery, and
 * nothing is written or sent. The state that says "this speaker has been reminded" is the
 * delivery itself, which is also the thing an organizer can read, retry and audit.
 *
 * ## The occurrence is the deadline, not the offset
 *
 * It used to be `d{offsetDays}`, which had two costs this key does not. Changing `offsetDays`
 * changed the key, so every task already reminded about was reminded again under the new offset
 * — a wart this header used to record rather than fix. And an organizer extending one speaker's
 * deadline could not chase them again, because the key did not move when the deadline did.
 *
 * The key is now built by `taskReminderKey`, which content's organizer-initiated reminder uses
 * too, so a deliberate chase and this sweep converge on one delivery per (task, deadline)
 * instead of writing to the speaker twice about the same thing (#189).
 *
 * One deploy-time consequence, stated rather than discovered: a task already reminded about
 * under the old `d{offsetDays}` key is reminded once more under the new one. That is the
 * conservative direction — the speaker hears about work that is genuinely still open — and it
 * happens once.
 *
 * ## What "due soon" means here, and what it does not
 *
 * A task is reminded about once, when it is within `offsetDays` of its due date — and that
 * includes tasks already overdue, because from a reminder's point of view "due tomorrow" and
 * "was due last week" are the same fact, and excluding the second would silently skip every task
 * whose window passed while nothing was running.
 *
 * One reminder per task per deadline. An escalating series — three days before, then on the day,
 * then weekly while overdue — is a different feature: each step needs its own key, and somebody
 * has to decide when nagging stops. Moving the deadline *is* a new occurrence, which is the one
 * case where a speaker hears about the same task twice, and deliberately so.
 *
 * @spec PRD-COM-001 PRD-SPK-002
 */
// The key both reminder paths build, so this sweep and an organizer's own send cannot disagree
// about whether a speaker has already been told. Content's declared surface, not a deep import.
import { type CommunicationsContentQuery, taskReminderKey } from "../content/public";
import { CommunicationsInputError, CommunicationsNotFoundError } from "./errors";
import type { CommunicationsEnqueue } from "./public";

/** The template a reminder renders from. Seeded; an organizer may publish new versions. */
export const REMINDER_TEMPLATE_KEY = "speaker-task-reminder";

/** How far ahead of its due date a task is reminded about. */
export const REMINDER_OFFSET_DAYS = 3;

/**
 * The most tasks one tick will consider.
 *
 * A Worker invocation has a bounded subrequest budget, and the first tick after this ships meets
 * the entire backlog of open tasks at once. Bounding it means that backlog is worked through
 * over several ticks, oldest first, instead of one invocation dying partway and retrying the
 * same doomed batch every minute. Nothing is lost: a task the bound excluded is still open and
 * still due, so the next tick sees it.
 */
export const REMINDER_BATCH_LIMIT = 100;

export interface TaskReminderDependencies {
  readonly work: CommunicationsContentQuery;
  readonly enqueue: CommunicationsEnqueue;
  /** Which organization runs an event. Events owns the answer; this asks rather than joins. */
  readonly organizationOf: (eventId: string) => Promise<string | null>;
  readonly now: () => Date;
  readonly offsetDays?: number;
  readonly templateKey?: string;
  readonly limit?: number;
  /** Reports a reminder that could not be queued. Never called for an ordinary duplicate. */
  readonly onFailure?: (fields: Record<string, unknown>) => void;
}

export interface TaskReminderResult {
  /** Tasks inside the window this tick, whether or not they had already been reminded about. */
  readonly considered: number;
  /** Reminders this tick actually wrote. Zero on every tick after the first, which is correct. */
  readonly enqueued: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Queue a reminder for every open task now inside the window, and none for one already sent.
 *
 * Never throws. It runs from `scheduled()` alongside the outbox drain, and a single task with a
 * broken template must not stop the drain or the remaining reminders — the failure is reported
 * through `onFailure` with the ids needed to act on it, and the tick continues.
 */
export async function enqueueDueTaskReminders(
  dependencies: TaskReminderDependencies,
): Promise<TaskReminderResult> {
  const offsetDays = dependencies.offsetDays ?? REMINDER_OFFSET_DAYS;
  const templateKey = dependencies.templateKey ?? REMINDER_TEMPLATE_KEY;
  const dueBefore = new Date(dependencies.now().getTime() + offsetDays * DAY_MS).toISOString();
  let due: Awaited<ReturnType<CommunicationsContentQuery["listOpenSpeakerWork"]>>;
  try {
    due = await dependencies.work.listOpenSpeakerWork(
      dueBefore,
      dependencies.limit ?? REMINDER_BATCH_LIMIT,
    );
  } catch (error) {
    // ERROR-INTENT: this is the one failure that would stall the whole tick. `scheduled()` runs
    // reminders before the drain, so a storage failure reading open tasks propagating out of
    // here would leave every queued delivery unsent until the read started working again —
    // reminders taking the outbox down with them. It is reported and the tick continues to the
    // drain; the next tick reads again, and nothing durable was missed because nothing was
    // written.
    dependencies.onFailure?.({
      reason: "open speaker work could not be read",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { considered: 0, enqueued: 0 };
  }

  // One lookup per event rather than per task: a conference's tasks cluster into a handful of
  // events, and this is inside a cron tick's subrequest budget.
  const organizations = new Map<string, string | null>();
  let enqueued = 0;
  for (const task of due) {
    try {
      if (!organizations.has(task.eventId))
        organizations.set(task.eventId, await dependencies.organizationOf(task.eventId));
      const organizationId = organizations.get(task.eventId);
      if (!organizationId) {
        dependencies.onFailure?.({
          eventId: task.eventId,
          taskId: task.taskId,
          reason: "no owning organization",
        });
        continue;
      }
      const delivery = await dependencies.enqueue.enqueue({
        organizationId,
        eventId: task.eventId,
        idempotencyKey: taskReminderKey(task.taskId, task.dueAt),
        triggerType: "speaker.task_reminder",
        channel: "email",
        recipientRef: task.email,
        payload: {
          speakerName: task.speakerName,
          taskTitle: task.title,
          dueAt: task.dueAt,
        },
        templateKey,
      });
      if (delivery.created) enqueued += 1;
    } catch (error) {
      // ERROR-INTENT: one task's reminder failing — a missing template, a payload the template
      // cannot fill — must not stop the others or the drain that follows. Reported with the ids
      // needed to fix it rather than discarded, and the next tick retries it anyway because
      // nothing durable was written for this task.
      dependencies.onFailure?.({
        eventId: task.eventId,
        taskId: task.taskId,
        reason:
          error instanceof CommunicationsNotFoundError || error instanceof CommunicationsInputError
            ? error.message
            : "unexpected failure",
      });
    }
  }
  return { considered: due.length, enqueued };
}
