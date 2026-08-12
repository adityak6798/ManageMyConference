/*
 * Abstract triage (organizer) and the reviewer scoring queue.
 *
 * Triage leads on the organizer surface: statuses are tabs with counts, the
 * proposal table is the page, and the evaluation plan plus status pipeline are
 * folded into a secondary "Evaluation setup" panel — configuration is a rare act,
 * triage is the daily one. The reviewer surface inverts the old order so the
 * assigned proposal and its scoring form are the first thing on screen.
 */

import type { ReviewerQueueDto } from "@greenroom/contracts";
import { type FormEvent, Fragment, useState } from "react";
import { declareReviewConflict, saveReviewEvaluation } from "../api/review";
import "../styles/review.css";
import { IconCheck, IconWarning } from "../ui/icons";
import { Card, Notice, Pill, useActionFeedback } from "../ui/primitives";

import { message } from "./shared";

type QueueItem = ReviewerQueueDto["assignments"][number];
export function EvaluationCard({
  eventId,
  item,
  reload,
}: {
  eventId: string;
  item: QueueItem;
  reload: () => Promise<void>;
}) {
  const [notes, setNotes] = useState(item.evaluation?.notes ?? "");
  const [scores, setScores] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (item.evaluation?.scores ?? []).map(({ criterionId, score }) => [criterionId, score]),
    ),
  );
  const [attempted, setAttempted] = useState(false);
  const [conflicting, setConflicting] = useState(false);
  const [conflictReason, setConflictReason] = useState("");
  const [busy, setBusy] = useState(false);
  const feedback = useActionFeedback();
  const criteria = item.plan?.criteria ?? [];
  const unscored = criteria.filter((criterion) => scores[criterion.id] === undefined);

  const completed = item.evaluation?.state === "completed" ? item.evaluation : null;

  async function save(complete: boolean) {
    setAttempted(true);
    if (!item.plan) {
      feedback.announce(
        "error",
        "The organizer must configure an evaluation plan before scores can be saved.",
      );
      return;
    }
    if (unscored.length) {
      // Unscored criteria used to be submitted as the minimum score, which quietly
      // invented an opinion the reviewer never gave.
      feedback.announce(
        "error",
        `Give every criterion a score first. Still unscored: ${unscored.map(({ name }) => name).join(", ")}.`,
      );
      return;
    }
    setBusy(true);
    try {
      await saveReviewEvaluation(eventId, item.assignment.id, {
        scores: item.plan.criteria.map((criterion) => ({
          criterionId: criterion.id,
          score: scores[criterion.id] as number,
        })),
        notes,
        complete,
      });
      await reload();
      feedback.announce(
        "success",
        complete ? "Evaluation completed." : "Draft saved. You can finish it later.",
      );
    } catch (reason) {
      // ERROR-INTENT: the card reports the handled request failure in its live region.
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function declare(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await declareReviewConflict(eventId, item.assignment.id, conflictReason);
      await reload();
      feedback.announce("success", "Conflict recorded. The organizer will reassign this abstract.");
    } catch (reason) {
      // ERROR-INTENT: the card reports the handled request failure in its live region.
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  // Every state renders inside one card so the live region survives the state
  // change: completing used to unmount its own confirmation before it was read.
  if (completed)
    return (
      <Card
        labelledBy="evaluation-title"
        title="Your evaluation"
        hint="Only organizers see your scores and notes."
      >
        {feedback.node}
        <Notice tone="success">
          <IconCheck size={15} />
          <span>Evaluation submitted. Scores and conflicts are now locked.</span>
        </Notice>
        <dl className="review-scores">
          {completed.scores.map((score) => (
            <Fragment key={score.criterionId}>
              <dt>
                {criteria.find(({ id }) => id === score.criterionId)?.name ?? score.criterionId}
              </dt>
              <dd>{score.score}</dd>
            </Fragment>
          ))}
        </dl>
        {completed.notes ? (
          <p className="review-notes">
            <span className="detail-term">Your private notes</span>
            {completed.notes}
          </p>
        ) : null}
      </Card>
    );

  if (item.conflict)
    return (
      <Card
        labelledBy="evaluation-title"
        title="Your evaluation"
        hint="Only organizers see your scores and notes."
      >
        {feedback.node}
        <Notice tone="warn">
          <IconWarning size={15} />
          <span>
            Conflict declared: {item.conflict.reason}. This assignment can no longer be scored.
          </span>
        </Notice>
      </Card>
    );

  return (
    <Card
      labelledBy="evaluation-title"
      title="Your evaluation"
      hint="Only organizers see your scores and notes."
    >
      {!item.plan ? (
        <Notice tone="warn" role="alert">
          The organizer has not configured an evaluation plan yet, so this abstract cannot be
          scored.
        </Notice>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          // ERROR-INTENT: React form handlers cannot await; save announces failures.
          void save(false);
        }}
      >
        <fieldset className="review-fieldset">
          <legend>Scores</legend>
          {criteria.map((criterion) => {
            const value = scores[criterion.id];
            const missing = attempted && value === undefined;
            return (
              <div className="criterion" key={criterion.id}>
                <div className="field">
                  <label htmlFor={`score-${criterion.id}`}>{criterion.name}</label>
                  <p className="hint" id={`hint-${criterion.id}`}>
                    {criterion.description} · {criterion.minScore} to {criterion.maxScore}
                  </p>
                </div>
                <div className="criterion-input">
                  <select
                    id={`score-${criterion.id}`}
                    aria-describedby={`hint-${criterion.id}`}
                    aria-required="true"
                    aria-invalid={missing}
                    value={value === undefined ? "" : String(value)}
                    onChange={(event) =>
                      setScores((current) => {
                        const next = { ...current };
                        if (event.target.value === "") delete next[criterion.id];
                        else next[criterion.id] = Number(event.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="">Not scored</option>
                    {Array.from(
                      { length: criterion.maxScore - criterion.minScore + 1 },
                      (_, index) => criterion.minScore + index,
                    ).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  {value === undefined ? (
                    <Pill tone={missing ? "danger" : "neutral"}>Not scored</Pill>
                  ) : (
                    <Pill tone="ok">
                      {value} of {criterion.maxScore}
                    </Pill>
                  )}
                </div>
              </div>
            );
          })}
        </fieldset>

        <div className="field review-notes-field">
          <label htmlFor="review-notes">Private notes</label>
          <textarea
            id="review-notes"
            value={notes}
            maxLength={5000}
            onChange={(event) => setNotes(event.target.value)}
          />
          <p className="hint">Shared with organizers only, never with the submitter.</p>
        </div>

        {unscored.length ? (
          <p className="score-guard" id="score-guard">
            {unscored.length} of {criteria.length} criteria still need a score.
          </p>
        ) : null}

        {feedback.node}

        <div className="toolbar review-actions">
          <button
            type="submit"
            className="secondary"
            disabled={busy || !item.plan}
            aria-describedby={unscored.length ? "score-guard" : undefined}
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={busy || !item.plan}
            aria-describedby={unscored.length ? "score-guard" : undefined}
            onClick={() => {
              // ERROR-INTENT: React event handlers cannot await; save announces failures.
              void save(true);
            }}
          >
            Complete evaluation
          </button>
          {conflicting ? null : (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setConflicting(true)}
            >
              Declare a conflict
            </button>
          )}
        </div>
      </form>

      {conflicting ? (
        <form
          className="conflict-form"
          onSubmit={(event) => {
            // ERROR-INTENT: React form handlers cannot await; declare announces failures.
            void declare(event);
          }}
        >
          <div className="field">
            <label htmlFor="conflict-reason">Why can you not review this abstract?</label>
            <input
              id="conflict-reason"
              value={conflictReason}
              required
              minLength={3}
              maxLength={500}
              placeholder="Professional relationship"
              onChange={(event) => setConflictReason(event.target.value)}
            />
            <p className="hint">
              Organizers see this reason. Declaring a conflict locks the assignment.
            </p>
          </div>
          <div className="toolbar">
            <button type="submit" disabled={busy}>
              Confirm conflict
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setConflicting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
