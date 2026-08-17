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
import { configureProposalStatuses } from "../api/review";
import "../styles/review.css";
import { IconPlus } from "../ui/icons";
import { useActionFeedback } from "../ui/primitives";

import { DECISION_STATUS_KEYS, message } from "./shared";
export function StatusForm({
  eventId,
  data,
  onSaved,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  onSaved: () => Promise<void>;
}) {
  const [statuses, setStatuses] = useState(data.statuses.map((status) => ({ ...status })));
  const [busy, setBusy] = useState(false);
  const feedback = useActionFeedback();
  // Triage reloads the workspace after every transition. Re-seeding the editor from
  // that response used to throw away whatever the organizer had typed, so edited
  // forms now hold their ground until they are saved or explicitly discarded.
  const edited = useRef(false);

  const reset = useCallback(() => {
    edited.current = false;
    setStatuses(data.statuses.map((status) => ({ ...status })));
  }, [data.statuses]);

  useEffect(() => {
    if (!edited.current) reset();
  }, [reset]);

  function update(index: number, label: string) {
    edited.current = true;
    setStatuses((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, label } : item)),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const configured = statuses.map((status, sortOrder) => ({
      ...status,
      key:
        status.key ||
        status.label
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
      label: status.label.trim(),
      sortOrder,
    }));
    setBusy(true);
    try {
      const saved = await configureProposalStatuses(eventId, {
        statuses: configured,
      });
      edited.current = false;
      await onSaved();
      /*
       * The server completes a saved set rather than refusing it — the reserved decision
       * statuses always come back — so a 2xx does not prove the pipeline now reads the way the
       * form does. Announcing an unqualified success over a set the server changed is how
       * "Remove Accepted" reported success while the row came back at the other end of the
       * list. Compare, and say so when they differ.
       */
      const asSent = configured.map(({ key, label }) => `${key}=${label}`).join("|");
      const asStored = [...saved.statuses]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ key, label }) => `${key}=${label}`)
        .join("|");
      feedback.announce(
        "success",
        asSent === asStored
          ? "Proposal statuses saved."
          : `Proposal statuses saved, with changes. The pipeline is now ${[...saved.statuses]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map(({ label }) => label)
              .join(", ")}.`,
      );
    } catch (reason) {
      // ERROR-INTENT: the form reports the handled failure in its own live region.
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="setup-form"
      onSubmit={(event) => {
        // ERROR-INTENT: React form handlers cannot await; submit announces failures.
        void submit(event);
      }}
    >
      <div className="setup-heading">
        <h3>Proposal statuses</h3>
        <p className="hint">
          The pipeline every abstract moves through, in order. A status that is currently in use
          cannot be removed, and Accepted and Declined are always part of the pipeline.
        </p>
      </div>
      {statuses.map((status, index) => (
        <div className="status-row" key={status.key || `new-${index}`}>
          <div className="field">
            <label htmlFor={`status-${index}`}>Status {index + 1} label</label>
            <input
              id={`status-${index}`}
              value={status.label}
              onChange={(event) => update(index, event.target.value)}
              required
              maxLength={80}
            />
          </div>
          {/*
           * No Remove on the two reserved keys. The server completes any saved set with them, so
           * the button could only ever look like it worked: the row vanished from the form,
           * "Proposal statuses saved." was announced, and the status came back at the end of the
           * pipeline — reordering it — with any renamed label discarded. Renaming stays: it is
           * the label that is the organizer's, not the key the programme acts on.
           */}
          {DECISION_STATUS_KEYS.has(status.key) ? (
            <p className="hint status-reserved">
              Kept: this is the outcome the programme acts on. You can rename it.
            </p>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                edited.current = true;
                setStatuses((current) => current.filter((_, itemIndex) => itemIndex !== index));
              }}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {feedback.node}
      <div className="setup-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            edited.current = true;
            setStatuses((current) => [
              ...current,
              { key: "", label: "", sortOrder: current.length },
            ]);
          }}
        >
          <IconPlus size={14} />
          Add status
        </button>
        <button className="primary" type="submit" disabled={busy}>
          Save statuses
        </button>
        <button type="button" className="ghost" onClick={reset} disabled={busy}>
          Discard changes
        </button>
      </div>
    </form>
  );
}
