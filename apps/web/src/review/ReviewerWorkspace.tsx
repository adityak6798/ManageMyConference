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
import { useCallback, useEffect, useState } from "react";
import { getReviewerQueue } from "../api/review";
import "../styles/review.css";
import { IconInbox } from "../ui/icons";
import { Card, EmptyState, Notice, Pill } from "../ui/primitives";

import { EvaluationCard } from "./EvaluationCard";
import { message, type PillTone, ProposalAnswers } from "./shared";

type QueueItem = ReviewerQueueDto["assignments"][number];

function queueState(item: QueueItem): { label: string; tone: PillTone } {
  if (item.conflict) return { label: "Conflict declared", tone: "warn" };
  if (item.evaluation?.state === "completed") return { label: "Completed", tone: "ok" };
  if (item.evaluation) return { label: "Draft saved", tone: "info" };
  return { label: "Not started", tone: "neutral" };
}

export function ReviewerWorkspace({ eventId }: { eventId: string }) {
  const [data, setData] = useState<ReviewerQueueDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const load = useCallback(async () => setData(await getReviewerQueue(eventId)), [eventId]);

  useEffect(() => {
    setData(null);
    setActiveId(null);
    setError(null);
    // ERROR-INTENT: React effects cannot await; the rejection renders in this workspace.
    void load().catch((reason: unknown) => setError(message(reason)));
  }, [load]);

  /**
   * Which assignment the reviewer is working on.
   *
   * The first one is chosen for them, but only until the queue reloads: an auto-selection that
   * stays derived from whichever assignment is not yet finished moves the moment the reviewer
   * finishes it, so clicking "Complete evaluation" swapped in a different abstract with an empty
   * form and no word about what had just been submitted. Resolving it here and committing it
   * below makes the choice a fact about the session rather than a function of the data, so the
   * reviewer stays where they are and picks the next one from the queue themselves.
   */
  const items = data?.assignments ?? [];
  const resolved =
    items.find(({ assignment }) => assignment.id === activeId) ??
    items.find((item) => item.evaluation?.state !== "completed" && !item.conflict) ??
    items[0];
  const resolvedId = resolved?.assignment.id ?? null;
  useEffect(() => {
    if (resolvedId && resolvedId !== activeId) setActiveId(resolvedId);
  }, [resolvedId, activeId]);

  if (error) return <Notice tone="error">{error}</Notice>;

  if (!data)
    return (
      <>
        <Card tight>
          <div className="triage-skeleton" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div key={row} className="skeleton" style={{ height: 18 }} />
            ))}
          </div>
        </Card>
        <p className="visually-hidden" role="status">
          Loading your review assignments.
        </p>
      </>
    );

  if (!data.assignments.length)
    return (
      <Card>
        <EmptyState title="Nothing assigned to you yet" icon={<IconInbox size={20} />}>
          When an organizer assigns you an abstract for this event it appears here with its scoring
          form.
        </EmptyState>
      </Card>
    );

  const completed = data.assignments.filter(
    ({ evaluation }) => evaluation?.state === "completed",
  ).length;
  const active = resolved;
  if (!active) return null;

  return (
    <div className="split">
      <div className="review-main">
        <Card
          labelledBy="review-proposal-title"
          title={active.proposal.title}
          // The server masks the submitter out of the reviewer projection, so this surface
          // names the policy rather than printing the mask as if it were a person.
          hint={
            active.proposal.submitter
              ? `Submitted by ${active.proposal.submitterName}`
              : "Blind review — the submitter's name and contact details are hidden from reviewers."
          }
          actions={<Pill tone={queueState(active).tone}>{queueState(active).label}</Pill>}
        >
          <p className="review-abstract">{active.proposal.abstract}</p>
          <ProposalAnswers answers={active.proposal.answers} />
        </Card>

        <EvaluationCard key={active.assignment.id} eventId={eventId} item={active} reload={load} />
      </div>

      <Card
        labelledBy="review-queue-title"
        title="Your queue"
        hint={`${completed} of ${data.assignments.length} complete`}
        tight
      >
        <ul className="review-queue">
          {data.assignments.map((item) => {
            const state = queueState(item);
            const current = item.assignment.id === active.assignment.id;
            return (
              <li key={item.assignment.id}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => setActiveId(item.assignment.id)}
                >
                  <span className="queue-title">{item.proposal.title}</span>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
