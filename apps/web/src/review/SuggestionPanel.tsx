/*
 * The reviewer's view of an AI-drafted suggestion.
 *
 * Everything here follows from one rule: a reviewer must never be able to mistake a drafted value
 * for their own. So the panel is visually and structurally separate from the scoring form, the
 * provenance is rendered *with* the draft rather than behind a disclosure, and the two controls
 * are "Accept into my scores" and "Dismiss" — verbs that say who is doing what. There is no
 * automatic application, no pre-checked box, and no path from this panel to a completed
 * evaluation: accepting fills the form, and the reviewer still presses Complete themselves.
 *
 * The failure state gets the same care as the success state. A provider that is slow, throttled or
 * switched off produces a notice beside a scoring form that is still fully usable, because the
 * manual path is the product and this is an assist on top of it.
 */

import type { ReviewerQueueDto } from "@greenroom/contracts";
import { useState } from "react";
import { requestReviewSuggestion, respondToReviewSuggestion } from "../api/review";
import "../styles/review.css";
import { IconWarning } from "../ui/icons";
import { Notice, Pill, useActionFeedback } from "../ui/primitives";

import { message } from "./shared";

type QueueItem = ReviewerQueueDto["assignments"][number];
type Suggestion = NonNullable<QueueItem["suggestions"]>[number];
type Evaluation = NonNullable<QueueItem["evaluation"]>;
type Criterion = NonNullable<QueueItem["plan"]>["criteria"][number];

/**
 * Normalized provider codes the reviewer benefits from telling apart.
 *
 * Only two distinctions matter to somebody holding a mouse: is pressing the button again worth
 * anything, and is this a configuration problem somebody else has to fix. Every other code falls
 * through to the generic sentence rather than being paraphrased into false precision.
 */
const FAILURE_DETAIL: Record<string, string> = {
  PROVIDER_TIMEOUT: "The assistant did not answer in time.",
  PROVIDER_RATE_LIMITED: "The assistant is busy right now.",
  PROVIDER_UNAVAILABLE: "The assistant is unavailable right now.",
  PROVIDER_UNREACHABLE: "The assistant could not be reached.",
  PROVIDER_UNAUTHORIZED: "The assistant is not configured correctly here — tell an organizer.",
  PROVIDER_UNCONFIGURED: "The assistant is not configured correctly here — tell an organizer.",
  PROVIDER_REFUSED: "The assistant declined to draft a suggestion for this abstract.",
  MALFORMED_PROVIDER_RESPONSE: "The assistant returned something unusable.",
};

const failureDetail = (error: unknown): string => {
  const code = (error as { envelope?: { error?: { fieldErrors?: Record<string, string[]> } } })
    ?.envelope?.error?.fieldErrors?.suggestion?.[0];
  return (code && FAILURE_DETAIL[code]) ?? "The assistant could not draft a suggestion.";
};

const formatWhen = (iso: string) => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
};

/** The drafted value as the reviewer will see it in their own form. */
const displayValue = (value: number | string) =>
  typeof value === "number" ? String(value) : value;

export function SuggestionPanel({
  eventId,
  item,
  onAccepted,
  onChanged,
  disabled,
}: {
  eventId: string;
  item: QueueItem;
  /**
   * Applies the accepted draft to the open scoring form, so the reviewer sees what they took.
   *
   * `appendToNotes` is the summary when the reviewer asked for it, and `null` otherwise — a
   * summary to *add* rather than a notes field to replace, so their unsaved typing survives either
   * way.
   */
  onAccepted: (evaluation: Evaluation, appendToNotes: string | null) => void;
  onChanged: () => Promise<void>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [includeSummary, setIncludeSummary] = useState(false);
  const feedback = useActionFeedback();
  const criteria: readonly Criterion[] = item.plan?.criteria ?? [];
  // Only the outstanding one. An answered suggestion is an audit record, not a thing to act on,
  // and leaving it on screen would invite a second reading of a draft already dealt with.
  // The *newest* outstanding draft, not the oldest. The queue arrives oldest-first, and a reviewer
  // who somehow has two outstanding — a stale tab, a retried request — means the later one, which
  // is the one they just asked for.
  const offered = (item.suggestions ?? [])
    .filter((suggestion) => suggestion.state === "offered")
    .at(-1);

  async function draft() {
    setBusy(true);
    try {
      await requestReviewSuggestion(eventId, item.assignment.id);
      await onChanged();
      feedback.announce("success", "Draft ready. Nothing has been scored yet — read it first.");
    } catch (reason) {
      // ERROR-INTENT: the panel reports the handled failure in its live region and leaves the
      // scoring form untouched, which is the whole degradation design.
      feedback.announce("error", `${failureDetail(reason)} You can still score this yourself.`);
    } finally {
      setBusy(false);
    }
  }

  async function respond(suggestion: Suggestion, response: "accepted" | "rejected") {
    setBusy(true);
    try {
      const result = await respondToReviewSuggestion(
        eventId,
        item.assignment.id,
        suggestion.id,
        response,
        response === "accepted" && includeSummary,
      );
      // The summary, not the server's composed notes. The server appended it to the notes it had
      // stored, which is not what the reviewer is looking at — anything they typed since is only
      // in the browser, and handing back the stored version would delete it.
      if (result.evaluation)
        onAccepted(result.evaluation, includeSummary ? suggestion.summary : null);
      await onChanged();
      feedback.announce(
        "success",
        response === "accepted"
          ? "Copied into your draft. Review the values, then press Complete evaluation when you agree with them."
          : "Suggestion dismissed. No evaluation was recorded; the dismissal itself is kept as an audit record.",
      );
    } catch (reason) {
      // ERROR-INTENT: the panel reports the handled request failure in its live region.
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!offered)
    return (
      <div className="suggestion-panel">
        {feedback.node}
        <div className="toolbar">
          <button type="button" className="secondary" disabled={busy || disabled} onClick={draft}>
            Draft with the review assistant
          </button>
          <p className="hint">
            A drafted score is a suggestion. It is recorded only if you accept it, and it never
            completes your evaluation for you.
          </p>
        </div>
      </div>
    );

  // The abstract has been edited since this draft was written, so the reasoning below may be
  // about text that is no longer on screen. Said plainly rather than left for the reviewer to
  // work out from two timestamps.
  const stale =
    Boolean(item.proposalRevision) && item.proposalRevision !== offered.provenance.proposalRevision;

  return (
    // A section rather than a div: the draft is a distinct region of the evaluation card and a
    // screen-reader user needs to be able to tell where the assistant's values stop and their own
    // form begins — which is the same reason it is visually separated.
    <section className="suggestion-panel" aria-labelledby="suggestion-title">
      {feedback.node}
      <div className="suggestion-head">
        <h4 id="suggestion-title">Assistant's draft</h4>
        <Pill tone="info">Not scored</Pill>
      </div>

      {/*
       * Provenance sits above the draft, not below it and not behind a toggle: the reviewer needs
       * to know what produced this before they read it, and a fixture-drafted score reads very
       * differently from a model-drafted one.
       */}
      <dl className="suggestion-provenance">
        <dt>Model</dt>
        <dd>{offered.provenance.model}</dd>
        <dt>Prompt</dt>
        <dd>{offered.provenance.promptVersion}</dd>
        <dt>Drafted</dt>
        <dd>{formatWhen(offered.provenance.generatedAt)}</dd>
        <dt>Abstract version</dt>
        <dd>{offered.provenance.proposalRevision}</dd>
      </dl>

      {stale ? (
        <Notice tone="warn" role="alert">
          <IconWarning size={15} />
          <span>
            This abstract has been edited since the draft was written, so the reasoning below may
            describe text that is no longer shown. Draft again for a current one.
          </span>
        </Notice>
      ) : null}

      <p className="suggestion-summary">{offered.summary}</p>

      <dl className="suggestion-scores">
        {criteria.map((criterion) => {
          const score = offered.scores.find((entry) => entry.criterionId === criterion.id);
          return (
            <div className="suggestion-score" key={criterion.id}>
              <dt>{criterion.name}</dt>
              <dd>
                {score ? (
                  <>
                    <Pill tone="neutral">{displayValue(score.value)}</Pill>
                    <span className="suggestion-rationale">{score.rationale}</span>
                  </>
                ) : (
                  <span className="suggestion-rationale">
                    No draft for this criterion — score it yourself.
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="field suggestion-notes-choice">
        <label htmlFor="suggestion-include-summary">
          <input
            id="suggestion-include-summary"
            type="checkbox"
            checked={includeSummary}
            disabled={busy || disabled}
            onChange={(event) => setIncludeSummary(event.target.checked)}
          />
          Also copy the summary into my private notes
        </label>
        <p className="hint">
          Off by default. Organizers read your notes as your own words, so the summary is added only
          if you ask for it.
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; respond announces failures.
            void respond(offered, "accepted");
          }}
        >
          Accept into my scores
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || disabled}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; respond announces failures.
            void respond(offered, "rejected");
          }}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
