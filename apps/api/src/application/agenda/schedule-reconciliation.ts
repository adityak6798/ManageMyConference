/*
 * Sweeping the events whose stored schedule revisions have fallen behind their history.
 *
 * `agenda_session_schedules` is derived state that is written rather than recomputed (issue #141),
 * and `GAP-024` recorded what that costs: a publication written by anything other than
 * `D1AgendaRepository.publish` — the old Worker during a deploy, an import, a repair script —
 * leaves the derived table describing a history that has moved on. Every read of that event's
 * schedule now re-derives it before answering, so the drift a *read* can reach is already closed.
 * This is the other half: the events nobody reads.
 *
 * **Why the repair is automatic, and what that costs.** Leaving it to a human means the harm runs
 * until somebody notices, and nothing surfaces the condition to notice: the organizer pressing
 * Send is shown a count and no error either way. The harm itself is mail — an invitation to a
 * session the programme does not schedule, or a withheld invitation for one that returned — and
 * mail does not roll back. So it repairs itself, on the tick, without being asked.
 *
 * The price of that decision is worth stating plainly rather than discovering later: **an
 * automatic repair can hide a write path that is producing drift.** If some future importer wrote
 * publications directly every hour, the repair would quietly correct after it forever and the
 * importer would look correct. The answer is not to leave the damage in place, it is to make the
 * repair loud — and the observer that does that belongs to the *repository*, not to this sweep.
 * Reads repair first for every event anybody opens, so this sweep only ever reaches the events
 * nobody read; an observer wired here would report exactly the events that matter least. See
 * `D1AgendaRepository`'s `onRepair`.
 *
 * What a reported repair means, once `1602` has settled: a repair whose drift counts are all zero
 * is the migration's backfill claiming a watermark it deliberately left unclaimed, one per
 * published event and never again. A repair with a non-zero count is a real divergence, and a
 * *recurring* one names the writer that needs fixing.
 *
 * @spec PRD-AGD-001 PRD-SPK-002
 */
import type { AgendaRepository, ScheduleReconciliation } from "./agenda-repository";

/**
 * How many events one sweep repairs.
 *
 * Each repair replays one event's whole publication history, so an unbounded sweep would turn a
 * one-minute tick into a scan of every board a deployment has ever published — the cost #141
 * removed, reintroduced on a schedule. What the bound leaves behind is not lost: the drifted rows
 * stay in the partial index, the next tick takes them, and any read of that event repairs it
 * immediately in the meantime.
 */
export const SCHEDULE_SWEEP_LIMIT = 20;

export interface ScheduleSweepResult {
  /** Events the storage reported as drifted, at most `limit` of them. */
  readonly scanned: number;
  /** Events this sweep brought back into agreement with their history. */
  readonly repaired: number;
  /**
   * Events that were drifted, were asked to repair, and did not.
   *
   * That is contention rather than breakage: every attempt lost its race to a publication, so
   * nothing was written and the event stays flagged. It is counted separately because it is
   * otherwise silent on every channel — it does not throw, so `failed` misses it, and no repair
   * happened, so the repair observer misses it too. An event being published faster than its
   * history can be walked is exactly the condition `REPAIR_ATTEMPTS` exists to stop looping on,
   * and a condition worth stopping on is worth reporting.
   */
  readonly contended: number;
  /** Events whose repair threw. Reported, never swallowed, and retried on the next tick. */
  readonly failed: number;
}

export interface ScheduleSweepDependencies {
  readonly schedules: Pick<AgendaRepository, "driftedEvents" | "reconcileSessionSchedules">;
  /** Told about every failure, with the event that caused it. */
  readonly onFailure?: (fields: { readonly eventId: string; readonly error: string }) => void;
}

/**
 * Repair every drifted event this sweep is allowed to take, and say what it did.
 *
 * One event's failure does not end the sweep. A tick that abandoned the remaining events because
 * the first one threw would let a single unrepairable event — a publication whose `schedule_json`
 * some future writer left unparseable, say — indefinitely protect every other event's drift from
 * being fixed. The failure is reported rather than swallowed and the event stays flagged, so the
 * next tick tries it again and the observer sees it happen every minute, which is the correct
 * amount of noise for something genuinely broken.
 *
 * What that does *not* buy: a permanently failing event keeps its place in `driftedEvents`, which
 * is ordered rather than rotated, so enough of them at the head of that order would crowd the
 * bound and starve the events behind. Twenty simultaneously unrepairable events is not a state
 * this system can reach on its own, and the failure log names every one of them every minute, so
 * the answer is to fix what is broken rather than to rotate around it — but the limitation is
 * real and is not what "each repaired event leaves the index" implies on its own.
 */
export async function sweepDriftedSchedules(
  dependencies: ScheduleSweepDependencies,
  limit: number = SCHEDULE_SWEEP_LIMIT,
): Promise<ScheduleSweepResult> {
  const drifted = await dependencies.schedules.driftedEvents(limit);
  let repaired = 0;
  let contended = 0;
  let failed = 0;
  for (const eventId of drifted) {
    try {
      const report = await dependencies.schedules.reconcileSessionSchedules(eventId, {
        repair: true,
      });
      // Reported by the repository's own observer, which sees repairs from every path. Counted
      // here so the tick can say what it did without a second log line for the same event.
      if (report.repaired) repaired += 1;
      else contended += 1;
    } catch (error) {
      // ERROR-INTENT: one unrepairable event must not protect every other event's drift from
      // being fixed. A tick that abandoned the rest because the first threw would let a single
      // bad event — a publication whose `schedule_json` some future writer left unparseable —
      // hold the whole sweep hostage indefinitely. Reported with the event that caused it rather
      // than discarded, and the event stays flagged, so the next tick tries it again and the
      // observer sees it every minute for as long as it is broken.
      failed += 1;
      dependencies.onFailure?.({
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { scanned: drifted.length, repaired, contended, failed };
}
