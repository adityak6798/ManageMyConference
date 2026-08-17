/*
 * Who owes what, per round, and the button that tells them.
 *
 * This replaces a list of event-wide counts that ended in the sentence "Reminder emails to
 * reviewers aren't available yet." — a capability gap stated in the UI and tracked as `GAP-010`,
 * blocked on a `reviewer.reminder` delivery trigger that migration `1706` now adds.
 *
 * Two things it is careful about. Progress is shown **per round**, because an outstanding count
 * that pools a finished first round with a live second one is the number that makes a reviewer
 * look behind when they are not. And the result of a reminder is shown **per reviewer**: queued,
 * already sent, nobody to write to, or nothing outstanding are four different outcomes, and
 * reporting them as "reminded 3 reviewers" is how an organizer comes to believe a message exists
 * that does not.
 *
 * Owned by the `review` domain. @spec PRD-REV-001 PRD-COM-001
 */

import type { OrganizerReviewWorkspaceDto } from "@greenroom/contracts";
import { useState } from "react";
import { remindReviewers } from "../api/review";
import "../styles/review.css";
import { Checkbox } from "../ui/fields";
import { IconReview } from "../ui/icons";
import { Card, EmptyState, Pill, useActionFeedback } from "../ui/primitives";
import { fieldErrorsOf, message, type PillTone, ROUND_STATE } from "./shared";

type Reminder = { outstanding: number; state: string };

const reminderKey = (round: number, reviewerId: string) => `${round}:${reviewerId}`;

/** What each reminder outcome says, and how loudly. Four states, four sentences. */
const REMINDER: Record<string, { label: string; tone: PillTone }> = {
  queued: { label: "Reminder queued", tone: "ok" },
  already_sent: { label: "Already reminded", tone: "info" },
  unaddressable: { label: "No email on file", tone: "danger" },
  nothing_outstanding: { label: "Nothing outstanding", tone: "neutral" },
};

export function ReviewerProgressPanel({
  eventId,
  data,
  reviewerName,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  reviewerName: (reviewerId: string) => string;
}) {
  const rounds = data.rounds ?? [];
  const roundProgress = data.roundProgress ?? [];
  const [round, setRound] = useState<number | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  /*
   * What the last reminder run reported, per round and reviewer.
   *
   * Component state rather than something read back from the server, and that is a deliberate
   * boundary: the durable record of a reminder is a `communication_deliveries` row, which
   * communications owns and which the audit timeline and delivery history show. Review does not
   * keep a second copy of somebody else's send state, so what this holds is the answer to the
   * request the organizer just made — and the answer distinguishes a fresh queue from a repeat,
   * so pressing again is honest rather than confusing.
   */
  const [sent, setSent] = useState<Record<string, Reminder>>({});
  const feedback = useActionFeedback();

  // Rounds that still have outstanding work, which are the only ones worth reminding about.
  const withOutstanding = rounds.filter((item) =>
    roundProgress.some(
      (entry) => entry.round === item.sequence && entry.outstanding > 0 && item.state === "open",
    ),
  );
  const activeRound = round ?? withOutstanding[0]?.sequence ?? null;
  const outstandingIn = roundProgress.filter(
    (entry) => entry.round === activeRound && entry.outstanding > 0,
  );

  async function remind(reviewerIds: readonly string[]) {
    if (activeRound === null || !reviewerIds.length) return;
    setBusy(true);
    try {
      const result = await remindReviewers(eventId, {
        round: activeRound,
        reviewerIds: [...reviewerIds],
      });
      setSent((current) => ({
        ...current,
        ...Object.fromEntries(
          result.reminders.map((entry) => [
            reminderKey(activeRound, entry.reviewerId),
            { outstanding: entry.outstanding, state: entry.state },
          ]),
        ),
      }));
      setSelected([]);
      const counted = (state: string) =>
        result.reminders.filter((entry) => entry.state === state).length;
      // Each outcome named with its own count. A single "reminders sent" would be false the first
      // time one recipient has no address, and the organizer would have no way to notice.
      const parts = [
        counted("queued") ? `${counted("queued")} queued` : "",
        counted("already_sent") ? `${counted("already_sent")} already reminded` : "",
        counted("unaddressable") ? `${counted("unaddressable")} with no email on file` : "",
        counted("nothing_outstanding") ? `${counted("nothing_outstanding")} already finished` : "",
      ].filter(Boolean);
      feedback.announce(
        counted("unaddressable") ? "error" : "success",
        `Reminders: ${parts.join(", ")}. Delivery state is in Communications history.`,
      );
    } catch (reason) {
      const detail = Object.values(fieldErrorsOf(reason)).flat();
      // ERROR-INTENT: this panel's live region reports the handled failure.
      feedback.announce(
        "error",
        detail.length ? detail.join(" ") : message(reason, "The reminders could not be sent."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      labelledBy="review-progress"
      title="Reviewer progress"
      hint="Assigned, completed and outstanding evaluations, per reviewer and round."
    >
      {roundProgress.length === 0 ? (
        <EmptyState title="Nothing assigned in any round" icon={<IconReview size={20} />}>
          Assign or distribute abstracts in a round and each reviewer's progress appears here.
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">
                Evaluation progress by round and reviewer
              </caption>
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col" className="num">
                    Assigned
                  </th>
                  <th scope="col" className="num">
                    Completed
                  </th>
                  <th scope="col" className="num">
                    Outstanding
                  </th>
                  <th scope="col">Reminder</th>
                </tr>
              </thead>
              <tbody>
                {roundProgress.map((entry) => {
                  const forRound = rounds.find((item) => item.sequence === entry.round);
                  const reminder = sent[reminderKey(entry.round, entry.reviewerId)];
                  return (
                    <tr key={`${entry.round}:${entry.reviewerId}`}>
                      <td data-label="Round">
                        {forRound?.name ?? `Round ${entry.round}`}
                        {forRound ? (
                          <span className="sub">{ROUND_STATE[forRound.state].label}</span>
                        ) : null}
                      </td>
                      <td className="primary-cell" data-label="Reviewer">
                        {reviewerName(entry.reviewerId)}
                      </td>
                      <td className="num" data-label="Assigned">
                        {entry.assigned}
                      </td>
                      <td className="num" data-label="Completed">
                        {entry.completed}
                      </td>
                      <td className="num" data-label="Outstanding">
                        {/* The number the whole panel exists for: 0 of N through to N of N. */}
                        {entry.outstanding}
                      </td>
                      <td data-label="Reminder">
                        {reminder && entry.round === activeRound ? (
                          <Pill tone={REMINDER[reminder.state]?.tone ?? "neutral"}>
                            {REMINDER[reminder.state]?.label ?? reminder.state}
                          </Pill>
                        ) : entry.outstanding === 0 ? (
                          <span className="empty-text">Complete</span>
                        ) : (
                          <span className="empty-text">Not reminded</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {withOutstanding.length ? (
            <fieldset className="reminder-controls">
              <legend className="group-label">Remind outstanding reviewers</legend>
              <div className="field">
                <label htmlFor="reminder-round">Round</label>
                <select
                  id="reminder-round"
                  value={activeRound ?? ""}
                  onChange={(event) => {
                    setRound(Number(event.target.value));
                    setSelected([]);
                  }}
                >
                  {withOutstanding.map((item) => (
                    <option key={item.sequence} value={item.sequence}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
              <ul className="reminder-picks">
                {outstandingIn.map((entry) => (
                  <li key={entry.reviewerId}>
                    {/* The shared checkbox draws a box; `.checkbox-label` around a bare input
                        inherits the control tier's `appearance: none` and draws nothing, so
                        every name in this list sat beside an invisible control. */}
                    <Checkbox
                      label={`${reviewerName(entry.reviewerId)} — ${entry.outstanding} outstanding`}
                      checked={selected.includes(entry.reviewerId)}
                      onChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, entry.reviewerId]
                            : current.filter((id) => id !== entry.reviewerId),
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
              <div className="toolbar">
                <button
                  className="primary"
                  type="button"
                  disabled={busy || !selected.length}
                  onClick={() => {
                    // ERROR-INTENT: React event handlers cannot await; remind announces every outcome.
                    void remind(selected);
                  }}
                >
                  Send reminder to {selected.length || "selected"}{" "}
                  {selected.length === 1 ? "reviewer" : "reviewers"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !outstandingIn.length}
                  onClick={() => {
                    // ERROR-INTENT: React event handlers cannot await; remind announces every outcome.
                    void remind(outstandingIn.map(({ reviewerId }) => reviewerId));
                  }}
                >
                  Remind everyone outstanding
                </button>
              </div>
              <p className="hint">
                One message per reviewer per round. Pressing again reports “already reminded” rather
                than sending a second copy.
              </p>
            </fieldset>
          ) : (
            <p className="hint">Every assigned evaluation in every open round is complete.</p>
          )}
        </>
      )}
      {feedback.node}
    </Card>
  );
}
