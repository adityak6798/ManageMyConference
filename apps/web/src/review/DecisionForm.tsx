import { useEffect, useRef, useState } from "react";
import { IconWarning } from "../ui/icons";
import type { useActionFeedback } from "../ui/primitives";
import {
  type Decision,
  type DecisionOutcome,
  listTitles,
  OUTCOME_LABEL,
  type Proposal,
} from "./shared";
export type DecisionState = "open" | "retry" | "done";

/**
 * The confirmation an accept or decline opens, for one abstract or for a selection.
 *
 * It names what is being decided and, for an acceptance, who will become each session's speaker
 * — the organizer is authorizing content, not flipping a status, so the resolved titles and
 * submitters have to be on screen before they confirm. Field-level failures from either domain
 * render against the control that produced them rather than at the top of the page, and the
 * panel stays mounted afterwards so its live region survives the outcome.
 */
export function DecisionForm({
  proposals,
  outcome,
  recorded,
  state,
  busy,
  errors,
  feedback,
  onConfirm,
  onClose,
}: {
  proposals: readonly Proposal[];
  outcome: DecisionOutcome;
  recorded: ReadonlyMap<string, Decision>;
  state: DecisionState;
  busy: boolean;
  errors: Record<string, string[]>;
  feedback: ReturnType<typeof useActionFeedback>;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const single = proposals.length === 1 ? proposals[0] : null;
  const decided = single ? recorded.get(single.id) : undefined;
  const [note, setNote] = useState(decided?.note ?? "");
  const panel = useRef<HTMLDivElement>(null);
  const idSuffix = single ? single.id : `selection-${proposals.length}`;
  const noteId = `decision-note-${idSuffix}`;
  const reasonId = `decision-reason-${idSuffix}`;
  /**
   * Acceptance provisions a speaker from the submitter's contact address, so a submission that
   * carries none cannot be accepted at all. Offering an enabled Confirm here only produced a
   * recorded decision the content domain then refused; the control says why instead. One
   * unusable abstract blocks the whole selection rather than half-accepting the rest, because a
   * partly-applied bulk decision is the state this dialog exists to prevent.
   */
  const withoutContact =
    outcome === "accepted" ? proposals.filter(({ submitter }) => !submitter) : [];
  const unacceptable = withoutContact.length > 0;
  // Abstracts in this set that an earlier acceptance already turned into programme content.
  const reversals =
    outcome === "declined"
      ? proposals.filter((proposal) => recorded.get(proposal.id)?.outcome === "accepted")
      : [];
  const done = state === "done";
  // Same rule as the detail panel: the surface the action opened takes focus, so the
  // keyboard lands on what it just summoned instead of staying behind in the table.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  // Deduplicated: a selection whose abstracts failed for the same reason would otherwise
  // repeat that reason once per abstract, under duplicate React keys.
  const listed = [
    ...new Map(
      Object.entries(errors).flatMap(([field, messages]) =>
        messages.map((text): [string, string] => [`${field}:${text}`, text]),
      ),
    ),
  ].map(([key, text]) => ({ key, text }));
  const subject = single ? single.title : `${proposals.length} abstracts`;

  return (
    <div className="decision-confirm" ref={panel} tabIndex={-1}>
      <p className="decision-question">
        {done ? (
          <>
            {OUTCOME_LABEL[outcome]} <strong>{subject}</strong>.
          </>
        ) : (
          <>
            {outcome === "accepted" ? "Accept" : "Decline"} <strong>{subject}</strong>?
          </>
        )}
      </p>
      {single ? null : (
        <ul className="decision-list">
          {proposals.map((proposal) => {
            const prior = recorded.get(proposal.id);
            return (
              <li key={proposal.id}>
                {proposal.title}
                {prior ? (
                  <span className="sub">
                    Already recorded as {OUTCOME_LABEL[prior.outcome].toLowerCase()}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {done ? null : (
        <p className="hint" id={reasonId}>
          {outcome === "accepted"
            ? unacceptable
              ? single
                ? "This submission carries no contact address, so no speaker can be created from it and it cannot be accepted. Ask the submitter for an address, or add an email field to the published form and have them resubmit."
                : `${withoutContact.length} of these abstracts carry no contact address, so no speaker can be created from them and this selection cannot be accepted: ${listTitles(withoutContact)}. Clear them from the selection and accept the rest.`
              : single?.submitter
                ? `Creates a session from this abstract and links ${single.submitter.name} (${single.submitter.email}) as its speaker.`
                : `Creates a session from each of these ${proposals.length} abstracts and links its own submitter as the speaker.`
            : single
              ? `Records the outcome against ${single.submitterName} and moves the abstract to Declined. Nothing is sent to the submitter.`
              : `Records the outcome against each submitter and moves ${proposals.length} abstracts to Declined. Nothing is sent to the submitters.`}
        </p>
      )}
      {/*
       * Declining does not undo an acceptance. The session and speaker the earlier acceptance
       * created stay in the programme, so an organizer reversing a decision has to remove them
       * in Sessions & speakers. Saying so here is the difference between a correction and a
       * programme that quietly disagrees with its own triage board — and the sentence names the
       * control by the word printed on it, "Withdraw". It used to say "delete the session",
       * which is a button that does not exist on that screen, so the organizer was sent looking
       * for a word that is not there. A smaller version of the same defect this warning exists
       * to prevent.
       */}
      {reversals.length && !done ? (
        <p className="hint decision-warning">
          <IconWarning size={14} />
          <span>
            {single
              ? "This abstract was accepted, so a session and a speaker already exist for it."
              : `${reversals.length} of these abstracts were accepted, so sessions and speakers already exist for them: ${listTitles(reversals)}.`}{" "}
            Declining records the reversal but does not remove them — use Withdraw in Sessions &amp;
            speakers if it should leave the programme.
          </span>
        </p>
      ) : null}
      {done ? null : (
        <div className="field">
          <label htmlFor={noteId}>Decision note (optional)</label>
          <input
            id={noteId}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            aria-describedby={`${noteId}-hint`}
          />
          <p className="hint" id={`${noteId}-hint`}>
            Stored with who decided and when. Organizers only.
          </p>
        </div>
      )}
      {listed.length ? (
        <ul className="decision-errors">
          {listed.map((entry) => (
            <li className="error-text" key={entry.key}>
              {entry.text}
            </li>
          ))}
        </ul>
      ) : null}
      {feedback.node}
      <div className="toolbar decision-actions">
        {/*
         * Nothing to confirm once the decision is recorded and its session exists. Leaving an
         * enabled "Confirm acceptance" under an answered question reads as "the first click did
         * not take", and pressing it only re-posts the identical decision.
         */}
        {done ? null : (
          <button
            type="button"
            disabled={unacceptable}
            aria-disabled={busy || unacceptable}
            // The hint above is the reason, so it is the control's accessible description rather
            // than a sentence a screen-reader user has to go looking for.
            aria-describedby={unacceptable ? reasonId : undefined}
            onClick={() => {
              if (busy || unacceptable) return;
              onConfirm(note);
            }}
          >
            {state === "retry"
              ? "Retry session creation"
              : outcome === "accepted"
                ? "Confirm acceptance"
                : "Confirm decline"}
          </button>
        )}
        {/* Promoted to the primary action once it is the only one left, but never renamed:
            this is the control that dismisses the dialog in every state. */}
        <button
          type="button"
          className={done ? undefined : "ghost"}
          aria-disabled={busy}
          onClick={() => {
            // Honour the same in-flight rule as Confirm: closing here would unmount this
            // panel's live region and the decision's outcome would be announced to nobody.
            if (busy) return;
            onClose();
          }}
        >
          Close
        </button>
        {decided && !done ? (
          <span className="hint">
            Already recorded as {OUTCOME_LABEL[decided.outcome].toLowerCase()} by{" "}
            {decided.decidedBy}.
          </span>
        ) : null}
      </div>
    </div>
  );
}
