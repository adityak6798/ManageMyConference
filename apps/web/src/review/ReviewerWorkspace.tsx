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
import { useCallback, useEffect, useRef, useState } from "react";
import { getReviewerQueue } from "../api/review";
import "../styles/review.css";
import { IconInbox } from "../ui/icons";
import {
  Card,
  EmptyState,
  GutterList,
  GutterRow,
  LoadFailure,
  Notice,
  Pill,
  SkeletonRows,
  useLoad,
} from "../ui/primitives";

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const fetchQueue = useCallback((id: string) => getReviewerQueue(id), []);
  const describeLoadFailure = useCallback((reason: unknown) => message(reason), []);
  const { data, error, reload: load } = useLoad(eventId, fetchQueue, describeLoadFailure);
  /*
   * Which queue row the keyboard is on, which is not which abstract is open.
   *
   * The queue is a list of choices, so it takes one tab stop and the arrow keys move inside it
   * — the pattern the agenda board already implements one directory away. Moving focus is not
   * choosing: a reviewer arrowing past a row must not load it, because loading it replaces the
   * abstract they are reading. Enter and Space choose, as they do on any button.
   */
  const [focusRow, setFocusRow] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
  /*
   * Committed against the value this holds when the effect runs, not the one the render saw.
   *
   * React flushes a passive effect after the commit that scheduled it, so comparing against the
   * `activeId` of that render let this undo a choice made in between: pressing a row on a queue
   * that had only just painted put the auto-chosen abstract back on screen instead of the one that
   * was pressed. That is the same defect the state above exists to prevent — a derivation moving
   * the abstract out from under whoever is reading it — one frame narrower, so the reviewer's own
   * press has to win any race with it. Overwriting is left for the one case that needs it: a
   * selection whose assignment is no longer in the queue at all.
   */
  useEffect(() => {
    setActiveId((current) =>
      current !== null && items.some(({ assignment }) => assignment.id === current)
        ? current
        : resolvedId,
    );
  }, [items, resolvedId]);

  if (error) return <LoadFailure what="your review queue" error={error} onRetry={load} />;

  if (!data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading your review assignments" />
      </Card>
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

  const activeIndex = data.assignments.findIndex(
    ({ assignment }) => assignment.id === active.assignment.id,
  );
  /*
   * The next abstract that still wants an evaluation, offered when this one is finished.
   *
   * Finishing used to be a dead end: the completed card said "Evaluation submitted" and the
   * reviewer had to go back to the queue and work out which row was next. The queue deliberately
   * does not jump on its own — that was a real defect, because it swapped the abstract out from
   * under whoever had just submitted — so the way forward is offered rather than taken.
   */
  const next =
    data.assignments
      .slice(activeIndex + 1)
      .concat(data.assignments.slice(0, Math.max(activeIndex, 0)))
      .find((item) => item.evaluation?.state !== "completed" && !item.conflict) ?? null;

  /** Roving focus inside the queue: arrows move, Enter and Space choose. */
  const moveFocus = (to: number) => {
    const bounded = Math.max(0, Math.min(data.assignments.length - 1, to));
    setFocusRow(bounded);
    rowRefs.current[bounded]?.focus();
  };

  return (
    <div className="reviewer-workspace">
      <div className="reviewer-layout">
        {/*
          The queue follows the reviewer down a long abstract. It used to scroll away with the
          page, so by the time somebody had read a 900-word submission there was no queue on
          screen to move on with.
        */}
        <div className="reviewer-queue-pane">
          <Card
            labelledBy="review-queue-title"
            title="Your queue"
            // The one statement of progress. It was made three times in 120px — a heading, a
            // figure beside it, and this hint — under a second page header the shell had
            // already rendered.
            hint={`${completed} of ${data.assignments.length} complete`}
            tight
          >
            <GutterList label="Abstracts assigned to you">
              {data.assignments.map((item, index) => {
                const state = queueState(item);
                const current = item.assignment.id === active.assignment.id;
                return (
                  <GutterRow
                    key={item.assignment.id}
                    // Where this abstract sits in the queue: the figure the row is about.
                    measure={index + 1}
                    measureLabel="Abstract"
                    active={current}
                    title={
                      <button
                        type="button"
                        className="queue-choice"
                        aria-current={current ? "true" : undefined}
                        tabIndex={index === focusRow ? 0 : -1}
                        ref={(node) => {
                          rowRefs.current[index] = node;
                        }}
                        onFocus={() => setFocusRow(index)}
                        onKeyDown={(keyEvent) => {
                          const to =
                            keyEvent.key === "ArrowDown"
                              ? index + 1
                              : keyEvent.key === "ArrowUp"
                                ? index - 1
                                : keyEvent.key === "Home"
                                  ? 0
                                  : keyEvent.key === "End"
                                    ? data.assignments.length - 1
                                    : null;
                          if (to === null) return;
                          keyEvent.preventDefault();
                          moveFocus(to);
                        }}
                        onClick={() => setActiveId(item.assignment.id)}
                      >
                        {item.proposal.title}
                      </button>
                    }
                    status={<Pill tone={state.tone}>{state.label}</Pill>}
                  />
                );
              })}
            </GutterList>
          </Card>
        </div>

        <div className="review-main">
          <Card
            labelledBy="review-proposal-title"
            title={active.proposal.title}
            /*
             * Which policy this abstract arrives under, said in the words of what the reviewer can
             * see rather than as a flag.
             *
             * The policy is the round's now, not the deployment's: a blind first pass and an open
             * programme committee are two different rounds of the same event, and the server sends
             * genuinely different bytes for each. So this reads the round rather than inferring
             * blindness from a missing field — a proposal whose submitter is absent because the form
             * collected no address is not a blind review, and the old test conflated the two.
             *
             * The open-review branch **names the author**, which is the whole point of the setting.
             * It previously said "Authors and co-authors are shown" and then showed only the
             * co-authors: the name was on the wire and rendered nowhere, so an organizer who turned
             * blind review off got the exposure without the benefit.
             */
            hint={
              active.round && !active.round.anonymized
                ? `${active.round.name} — open review. Submitted by ${active.proposal.submitterName}.`
                : `${active.round?.name ? `${active.round.name} — ` : ""}Blind review — the submitter's name and contact details are hidden from reviewers.`
            }
            actions={<Pill tone={queueState(active).tone}>{queueState(active).label}</Pill>}
          >
            {active.roundClosedReason ? (
              <Notice tone="warn" role="alert">
                {active.roundClosedReason}
              </Notice>
            ) : null}
            <p className="review-abstract">{active.proposal.abstract}</p>
            <ProposalAnswers answers={active.proposal.answers} />
            {/* Only an open round carries these; a blind projection has no co-authors to render. */}
            {(active.proposal.coAuthors ?? []).length ? (
              <p className="detail-reviewers">
                <span className="detail-term">Co-authors and presenters</span>
                {(active.proposal.coAuthors ?? [])
                  .map(({ name, role }) => `${name} — ${role}`)
                  .join(", ")}
              </p>
            ) : null}
          </Card>

          <EvaluationCard
            key={active.assignment.id}
            eventId={eventId}
            item={active}
            // A closed round is view-only, and the queue says so before the reviewer types rather
            // than refusing the save afterwards.
            readOnlyReason={active.roundClosedReason ?? null}
            suggestionsEnabled={data.suggestionsEnabled ?? false}
            // Named, so finishing an evaluation offers the next abstract instead of ending in a
            // full stop. The queue still does not move on its own.
            {...(next
              ? {
                  next: {
                    title: next.proposal.title,
                    onOpen: () => setActiveId(next.assignment.id),
                  },
                }
              : {})}
            reload={async () => {
              await load();
            }}
          />
        </div>
      </div>
    </div>
  );
}
