import { useEffect, useMemo, useState } from "react";
import { DECISION_STATUS_KEYS, type Reviewer, type StatusDefinition } from "./shared";
export function ProposalActions({
  idPrefix,
  statusLabel,
  reviewerLabel,
  statuses,
  reviewers,
  currentStatus,
  busy,
  onTransition,
  onAssign,
}: {
  idPrefix: string;
  statusLabel: string;
  reviewerLabel: string;
  statuses: readonly StatusDefinition[];
  reviewers: readonly Reviewer[];
  currentStatus?: string;
  busy: boolean;
  onTransition: (toStatus: string) => void;
  onAssign: (reviewerId: string) => void;
}) {
  const pipeline = useMemo(
    () => statuses.filter(({ key }) => !DECISION_STATUS_KEYS.has(key)),
    [statuses],
  );
  const [status, setStatus] = useState(() =>
    currentStatus && pipeline.some(({ key }) => key === currentStatus) ? currentStatus : "",
  );
  const [reviewerId, setReviewerId] = useState("");
  useEffect(() => {
    // Organizers can rename or delete statuses while this control is mounted.
    if (status && !pipeline.some(({ key }) => key === status)) setStatus("");
  }, [pipeline, status]);
  const statusHintId = `${idPrefix}-status-hint`;
  return (
    <div className="triage-actions">
      <div className="field">
        <label htmlFor={`${idPrefix}-status`}>{statusLabel}</label>
        <div className="triage-action-row">
          <select
            id={`${idPrefix}-status`}
            value={status}
            aria-describedby={statusHintId}
            onChange={(event) => setStatus(event.target.value)}
          >
            {/* No preselected destination: a single Move click used to send an abstract to
                whichever status happened to be first. */}
            <option value="">Choose a status</option>
            {pipeline.map((definition) => (
              <option key={definition.key} value={definition.key}>
                {definition.label}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !status} onClick={() => onTransition(status)}>
            Move
          </button>
        </div>
        <p className="hint" id={statusHintId}>
          Accepted and Declined are not on this list: they are recorded with Accept or Decline,
          which store who decided and create the session.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-reviewer`}>{reviewerLabel}</label>
        <div className="triage-action-row">
          <select
            id={`${idPrefix}-reviewer`}
            value={reviewerId}
            onChange={(event) => setReviewerId(event.target.value)}
          >
            <option value="">Choose reviewer</option>
            {reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={busy || !reviewerId}
            onClick={() => onAssign(reviewerId)}
          >
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * How far the decision the dialog is asking about has got.
 *
 * `open` — nothing recorded yet by this dialog, so Confirm is the action.
 * `retry` — the decisions are recorded and durable but at least one session was not created, so
 *   the same request is worth re-posting and the button says exactly that.
 * `done` — recorded, and for an acceptance the session exists. There is nothing left to press,
 *   which is why Confirm is withdrawn rather than left enabled under an answered question.
 */
