/*
 * Abstract triage (organizer) and the reviewer scoring queue.
 *
 * Triage leads on the organizer surface: statuses are tabs with counts, the
 * proposal table is the page, and the evaluation plan plus status pipeline are
 * folded into a secondary "Evaluation setup" panel — configuration is a rare act,
 * triage is the daily one. The reviewer surface inverts the old order so the
 * assigned proposal and its scoring form are the first thing on screen.
 */

import type { OrganizerReviewWorkspaceDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { configureReviewPlan } from "../api/review";
import "../styles/review.css";
import { IconPlus, IconWarning } from "../ui/icons";
import { Notice, useActionFeedback } from "../ui/primitives";

import { message } from "./shared";

const NEW_CRITERION = () => ({
  id: `c_${crypto.randomUUID().replaceAll("-", "")}`,
  name: "",
  description: "",
  minScore: 1,
  maxScore: 5,
});

export function RubricForm({
  eventId,
  data,
  onSaved,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  onSaved: () => Promise<void>;
}) {
  const planCriteria = data.plan?.criteria;
  const [criteria, setCriteria] = useState(
    planCriteria?.map((criterion) => ({ ...criterion })) ?? [
      {
        id: "primary",
        name: "Audience fit",
        description: "Overall strength for this event",
        minScore: 1,
        maxScore: 5,
      },
    ],
  );
  const [busy, setBusy] = useState(false);
  const feedback = useActionFeedback();
  // Same rule as the status editor: a background reload must not discard typing.
  const edited = useRef(false);
  // The rubric is frozen once assignments exist, so reviewers cannot be scored
  // against criteria that changed under them.
  const locked = data.assignments.length > 0 && Boolean(data.plan);

  const reset = useCallback(() => {
    edited.current = false;
    if (planCriteria) setCriteria(planCriteria.map((criterion) => ({ ...criterion })));
  }, [planCriteria]);

  useEffect(() => {
    if (!edited.current) reset();
  }, [reset]);

  function update(index: number, patch: Partial<(typeof criteria)[number]>) {
    edited.current = true;
    setCriteria((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  function move(index: number, delta: number) {
    edited.current = true;
    setCriteria((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + delta, 0, moved);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await configureReviewPlan(eventId, { criteria });
      edited.current = false;
      await onSaved();
      feedback.announce("success", "Evaluation plan saved.");
    } catch (reason) {
      // ERROR-INTENT: the form reports the handled failure in its own live region.
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  /*
   * The locked panel is a statement about what reviewers are scoring against, so it reads from
   * the server's plan and never from this editor's state. It used to render `criteria`, which
   * meant an organizer who was mid-edit when the first reviewer was assigned saw their own
   * unsaved wording presented as the rubric now in force — with the lock message attached and
   * the Save button they would have needed gone. The unsaved text is not silently dropped
   * either: it is named as unsaved.
   */
  if (locked)
    return (
      <section className="setup-form" aria-labelledby="rubric-locked">
        <div className="setup-heading">
          <h3 id="rubric-locked">Evaluation plan</h3>
          <p className="hint">
            Reviewers are already assigned, so the criteria are locked. Every reviewer scores the
            same rubric.
          </p>
        </div>
        {edited.current ? (
          <Notice tone="warn" role="alert">
            <IconWarning size={15} />
            <span>
              Reviewers were assigned while you were editing, so your unsaved changes were not
              applied. What is below is the rubric in force.
            </span>
          </Notice>
        ) : null}
        <dl className="rubric-summary">
          {(planCriteria ?? []).map((criterion) => (
            <div key={criterion.id}>
              <dt>{criterion.name}</dt>
              <dd>
                {criterion.description}
                <span className="sub">
                  Scores {criterion.minScore} to {criterion.maxScore}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    );

  return (
    <form
      className="setup-form"
      onSubmit={(event) => {
        // ERROR-INTENT: React form handlers cannot await; submit announces failures.
        void submit(event);
      }}
    >
      <div className="setup-heading">
        <h3>Evaluation plan</h3>
        <p className="hint">
          Every reviewer scores each criterion on its own range. The plan locks once reviewers are
          assigned.
        </p>
      </div>
      {criteria.map((criterion, index) => (
        <div className="rubric-row" key={criterion.id}>
          <div className="field">
            <label htmlFor={`criterion-${index}-name`}>Criterion {index + 1} name</label>
            <input
              id={`criterion-${index}-name`}
              value={criterion.name}
              onChange={(event) => update(index, { name: event.target.value })}
              required
              maxLength={80}
            />
          </div>
          <div className="field">
            <label htmlFor={`criterion-${index}-guidance`}>
              Guidance for criterion {index + 1}
            </label>
            <input
              id={`criterion-${index}-guidance`}
              value={criterion.description}
              onChange={(event) => update(index, { description: event.target.value })}
              required
              maxLength={300}
            />
          </div>
          <div className="field">
            <label htmlFor={`criterion-${index}-min`}>Minimum score</label>
            <input
              id={`criterion-${index}-min`}
              type="number"
              min={0}
              max={10}
              value={criterion.minScore}
              onChange={(event) => update(index, { minScore: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor={`criterion-${index}-max`}>Maximum score</label>
            <input
              id={`criterion-${index}-max`}
              type="number"
              min={1}
              max={10}
              value={criterion.maxScore}
              onChange={(event) => update(index, { maxScore: Number(event.target.value) })}
            />
          </div>
          <div className="rubric-row-actions">
            <button
              type="button"
              className="secondary small"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={index === criteria.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={criteria.length === 1}
              onClick={() => {
                edited.current = true;
                setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index));
              }}
            >
              Remove criterion
            </button>
          </div>
        </div>
      ))}
      {feedback.node}
      <div className="setup-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            edited.current = true;
            setCriteria((current) => [...current, NEW_CRITERION()]);
          }}
        >
          <IconPlus size={14} />
          Add criterion
        </button>
        <button type="submit" disabled={busy}>
          Save rubric
        </button>
        <button type="button" className="ghost" onClick={reset} disabled={busy || !data.plan}>
          Discard changes
        </button>
      </div>
    </form>
  );
}
