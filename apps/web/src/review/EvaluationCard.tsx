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
import { Field, SegmentedControl, type SelectOption } from "../ui/fields";
import { Card, Notice, useActionFeedback } from "../ui/primitives";
import { SuggestionPanel } from "./SuggestionPanel";
import { message } from "./shared";

type QueueItem = ReviewerQueueDto["assignments"][number];
type Criterion = NonNullable<QueueItem["plan"]>["criteria"][number];

/**
 * The values one criterion admits, as segments.
 *
 * A bounded scale is a row of choices, not a list to open: the reviewer is choosing between five
 * things they can already see. The native `<select>` this replaces cost four interactions per
 * criterion — open, read, move, commit — on the highest-volume control in the product.
 */
function criterionOptions(criterion: Criterion): readonly SelectOption[] {
  if (!criterion.type || criterion.type === "numeric")
    return Array.from({ length: criterion.maxScore - criterion.minScore + 1 }, (_, index) => {
      const value = String(criterion.minScore + index);
      return { value, label: value };
    });
  return "options" in criterion
    ? criterion.options.map((option) => ({ value: String(option), label: String(option) }))
    : [];
}

export function EvaluationCard({
  eventId,
  item,
  reload,
  suggestionsEnabled,
  next = null,
  readOnlyReason = null,
}: {
  eventId: string;
  item: QueueItem;
  reload: () => Promise<void>;
  /** Whether this deployment has an assistant at all. False hides the panel entirely. */
  suggestionsEnabled: boolean;
  /** The abstract to offer once this one is submitted, so finishing is not a dead end. */
  next?: { title: string; onOpen: () => void } | null;
  /**
   * Why this assignment cannot be worked on, or `null` when it can.
   *
   * Today that is only a round which is closed, a draft, or outside its window. The server refuses
   * the save either way; this exists so the reviewer meets the refusal *before* filling in a form,
   * rather than after — which is the difference between a rule and an ambush.
   */
  readOnlyReason?: string | null;
}) {
  const [notes, setNotes] = useState(item.evaluation?.notes ?? "");
  const [scores, setScores] = useState<Record<string, number | string>>(() =>
    Object.fromEntries(
      (item.evaluation?.scores ?? []).flatMap(({ criterionId, value, score }) => {
        const stored = value ?? score;
        return stored === undefined ? [] : [[criterionId, stored]];
      }),
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
          value: scores[criterion.id] as number | string,
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
        <Notice
          tone="success"
          // The way on. Submitting used to end the flow with a full stop and leave the reviewer
          // to work out from the queue which abstract they had not done yet.
          action={
            next ? (
              <button type="button" className="primary" onClick={next.onOpen}>
                Next: {next.title}
              </button>
            ) : null
          }
        >
          <span>
            Evaluation submitted. Scores and conflicts are now locked.
            {next ? "" : " Nothing else is waiting in your queue."}
          </span>
        </Notice>
        <dl className="review-scores">
          {completed.scores.map((score) => (
            <Fragment key={score.criterionId}>
              <dt>
                {criteria.find(({ id }) => id === score.criterionId)?.name ?? score.criterionId}
              </dt>
              <dd>{score.value ?? score.score}</dd>
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
        {/* A standing condition, not a response to anything the reviewer just did: the conflict
            was already declared when this card was opened. `warn` interrupts by default, which
            would announce it on every mount, so this one stays polite. */}
        <Notice tone="warn" role="status">
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
      {readOnlyReason ? (
        <Notice tone="warn" role="alert">
          {readOnlyReason}
        </Notice>
      ) : null}

      {/*
       * Above the form, because a draft is something to read before scoring rather than something
       * to discover afterwards — and withheld entirely when there is no assistant, so a deployment
       * with the port off shows exactly the surface it showed before this feature existed.
       *
       * Accepting writes the reviewer's draft on the server and hands it back here, and the values
       * are pushed into the open form rather than waiting for a reload: the reviewer should see
       * what they just took, in the fields they are about to submit.
       */}
      {/* No drafting into a round that will not accept what comes out of it. */}
      {suggestionsEnabled && item.plan && !readOnlyReason ? (
        <SuggestionPanel
          eventId={eventId}
          item={item}
          disabled={busy}
          onAccepted={(evaluation, appendToNotes) => {
            setScores(
              Object.fromEntries(
                evaluation.scores.flatMap(({ criterionId, value, score }) => {
                  const stored = value ?? score;
                  return stored === undefined ? [] : [[criterionId, stored]];
                }),
              ),
            );
            // Scores are what the reviewer asked for, so they land. Notes are never *replaced*:
            // the server's copy is composed from the notes it had stored, and anything typed
            // since exists only here — taking its version would delete that. When the reviewer
            // asked for the summary, it is appended to what is actually on screen.
            if (appendToNotes)
              setNotes((current) => [current, appendToNotes].filter(Boolean).join("\n\n"));
          }}
          onChanged={reload}
        />
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
            const numeric = !criterion.type || criterion.type === "numeric";
            const guidance = `${criterion.description} · Weight ${criterion.weight ?? 1}`;
            const clear = () =>
              setScores((current) => {
                const nextScores = { ...current };
                delete nextScores[criterion.id];
                return nextScores;
              });
            return (
              <div
                className={`criterion${criterion.type === "text" ? " criterion-text" : ""}`}
                key={criterion.id}
              >
                {criterion.type === "text" ? (
                  <Field
                    label={criterion.name}
                    hint={guidance}
                    id={`score-${criterion.id}`}
                    required
                    {...(missing ? { error: "Answer this criterion before saving." } : {})}
                  >
                    {(control) => (
                      <textarea
                        {...control}
                        className="control"
                        maxLength={criterion.maxLength}
                        value={value === undefined ? "" : String(value)}
                        onChange={(event) =>
                          setScores((current) => {
                            const nextScores = { ...current };
                            if (!event.target.value.trim()) delete nextScores[criterion.id];
                            else nextScores[criterion.id] = event.target.value;
                            return nextScores;
                          })
                        }
                      />
                    )}
                  </Field>
                ) : (
                  /*
                   * The scale, on screen, one key away.
                   *
                   * This is the highest-volume interaction in the product — a reviewer works
                   * through a queue giving four or five criteria a score each — and it was the
                   * slowest control the platform offers for a bounded 1–5 scale. As segments the
                   * whole scale is visible, the digit keys select directly, the arrows move
                   * within the group, and clearing a score back to "not scored" is an explicit
                   * control rather than a blank option in a list.
                   */
                  <SegmentedControl
                    id={`score-${criterion.id}`}
                    label={criterion.name}
                    hint={guidance}
                    numeric={numeric}
                    options={criterionOptions(criterion)}
                    value={value === undefined ? null : String(value)}
                    onChange={(chosen) =>
                      setScores((current) => ({
                        ...current,
                        [criterion.id]: numeric ? Number(chosen) : chosen,
                      }))
                    }
                    onClear={clear}
                    clearLabel={`Clear ${criterion.name}`}
                    {...(missing ? { error: "Give this criterion a score before saving." } : {})}
                  />
                )}
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
            disabled={busy || !item.plan || Boolean(readOnlyReason)}
            aria-describedby={unscored.length ? "score-guard" : undefined}
          >
            Save draft
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || !item.plan || Boolean(readOnlyReason)}
            aria-describedby={unscored.length ? "score-guard" : undefined}
            onClick={() => {
              // ERROR-INTENT: React event handlers cannot await; save announces failures.
              void save(true);
            }}
          >
            Complete evaluation
          </button>
          {conflicting || readOnlyReason ? null : (
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
            <button className="primary" type="submit" disabled={busy}>
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
