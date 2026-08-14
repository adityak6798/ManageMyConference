import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  advanceReviewRound,
  assignReviewer,
  distributeReviewers,
  getOrganizerReview,
  recordProposalDecision,
  removeReviewAssignment,
  transitionProposals,
} from "../api/review";
import "../styles/review.css";
import { IconInbox, IconReview } from "../ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback, useLoad } from "../ui/primitives";
import { RubricForm } from "./RubricForm";
import { StatusForm } from "./StatusForm";
import {
  type Assignment,
  DecisionForm,
  type DecisionOutcome,
  type DecisionState,
  fieldErrorsOf,
  listTitles,
  message,
  OUTCOME_LABEL,
  type Proposal,
  ProposalActions,
  ProposalAnswers,
  statusTone,
} from "./shared";

/** The audit grows without bound; triage only needs the tail of it on screen. */
const RECENT_CHANGES = 12;

// @spec PRD-ABS-001 PRD-REV-001
// This triage state owner intentionally exceeds 400 lines because selection, decisions, detail
// focus, dialog state, and background reloads must remain one lifecycle. Its remaining table and
// detail branches are single-use renderers, which issue #70 says not to extract for size alone;
// configuration, decision, assignment, and reviewer forms already own separate modules.
export function memberName(
  id: string,
  directory: readonly { id: string; name: string }[],
  currentActor?: { id: string; name: string },
): string {
  if (currentActor?.id === id) return currentActor.name;
  return directory.find((member) => member.id === id)?.name ?? id;
}

export function OrganizerReviewWorkspace({
  eventId,
  currentActor,
}: {
  eventId: string;
  currentActor?: { id: string; name: string };
}) {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [sortByScore, setSortByScore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which abstracts have their accept/decline confirmation open, and what it would record. A
  // selection decided from the bulk bar is the same dialog over more than one row.
  const [pending, setPending] = useState<{
    proposalIds: readonly string[];
    outcome: DecisionOutcome;
  } | null>(null);
  const [decisionState, setDecisionState] = useState<DecisionState>("open");
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string[]>>({});
  const feedback = useActionFeedback();
  const decisionFeedback = useActionFeedback();
  const detailRef = useRef<HTMLDivElement>(null);
  const decisionDialog = useRef<HTMLDialogElement>(null);

  /**
   * Closing is refused while a decision is in flight, for the same reason Confirm is: unmounting
   * the dialog takes its live region with it and the outcome is announced to nobody. This is the
   * one handler for the Close button, Escape, and a click on the backdrop.
   */
  const closeDecision = useCallback(
    (event?: { preventDefault(): void }) => {
      if (busy) {
        event?.preventDefault();
        return;
      }
      setPending(null);
    },
    [busy],
  );

  // `showModal()` is what makes the dialog modal — rendering `<dialog open>` gives a
  // non-modal box with no backdrop and no focus trap — so the element is driven imperatively
  // from the state that owns it.
  useEffect(() => {
    const dialog = decisionDialog.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  const fetchWorkspace = useCallback((id: string) => getOrganizerReview(id), []);
  const describeLoadFailure = useCallback((reason: unknown) => message(reason), []);
  const {
    data,
    error,
    loading,
    reload: load,
  } = useLoad(eventId, fetchWorkspace, describeLoadFailure);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    const filtered = data.proposals.filter((proposal) => {
      if (tab !== "all" && proposal.status !== tab) return false;
      if (!needle) return true;
      return [
        proposal.title,
        proposal.submitterName,
        proposal.submitter?.email ?? "",
        proposal.abstract,
      ]
        .concat(proposal.answers.map(({ value }) => value))
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
    if (!sortByScore) return filtered;
    const score = (proposalId: string) =>
      data.outcomes
        .filter((outcome) => outcome.proposalId === proposalId)
        .sort((left, right) => right.round - left.round)[0]?.averageScore ?? -Infinity;
    return filtered.sort((left, right) => score(right.id) - score(left.id));
  }, [data, search, sortByScore, tab]);

  useEffect(() => {
    if (openId) detailRef.current?.focus();
  }, [openId]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      await load();
      // Selection is organizer work-in-progress. Issue #70 requires background reloads after
      // transitions and assignments to preserve it along with unsaved configuration edits.
      feedback.announce("success", success);
    } catch (reason) {
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Decide one abstract, or every abstract in the selection.
   *
   * One request for the whole set: the server records each decision and, for an acceptance,
   * creates the session in the same call. This workspace does not reach into the content domain
   * to finish the job — it could not have made that pair atomic anyway, and a failure between the
   * two calls used to leave an abstract recorded as accepted with no session and no way to repair
   * it from here. The response says which half happened for each proposal; where a session is
   * missing the decision still stands, so re-posting the identical decision retries exactly that.
   */
  async function decide(proposals: readonly Proposal[], outcome: DecisionOutcome, note: string) {
    const only = proposals.length === 1 ? proposals[0] : null;
    setBusy(true);
    setDecisionErrors({});
    setDecisionState("open");
    try {
      const result = await recordProposalDecision(eventId, {
        proposalIds: proposals.map(({ id }) => id),
        outcome,
        note,
      });
      /*
       * The workspace is refreshed, but the organizer is not made to wait through it (#207).
       *
       * The response already carries the outcome of every proposal in this decision — that is
       * what `acceptances` is — so everything announced below is decided from it and nothing
       * below reads `data`. Awaiting the reload first meant the confirmation appeared one
       * further request after the work was already done, on the busiest write in the product.
       *
       * This is the **perceptual** half of #207 and is named as such: the server-side work is
       * unchanged and the reload still happens, so the audit tail and the score columns catch up
       * exactly as they did. What changes is that the organizer is told the moment the server
       * has finished rather than the moment the console has re-read everything.
       */
      // ERROR-INTENT: a failed refresh is `useLoad`'s to report — it keeps the last good data
      // and renders its own error state; rejecting here would hide a confirmed decision instead.
      void load().catch(() => undefined);
      // Absent for a decline, and — for a response that predates the composed route — absent for
      // an acceptance too, which is reported as unfinished rather than announced as done.
      const acceptances = result.acceptances ?? [];
      const acceptanceOf = (id: string) => acceptances.find(({ proposalId }) => proposalId === id);
      const unfinished =
        outcome === "accepted"
          ? proposals.filter(({ id }) => acceptanceOf(id)?.state !== "content")
          : [];
      if (unfinished.length) {
        const fields: Record<string, string[]> = {};
        for (const { id } of unfinished)
          for (const [field, messages] of Object.entries(acceptanceOf(id)?.fieldErrors ?? {}))
            fields[field] = [...(fields[field] ?? []), ...messages];
        setDecisionErrors(fields);
        setDecisionState("retry");
        const said =
          unfinished.map(({ id }) => acceptanceOf(id)?.detail).find(Boolean) ??
          "The server did not say what happened.";
        decisionFeedback.announce(
          "error",
          only
            ? `The acceptance decision was recorded, but the session was not created. ${said} Retry session creation to finish it.`
            : `The acceptance decisions were recorded, but ${unfinished.length} of ${proposals.length} sessions were not created: ${listTitles(unfinished)}. ${said} Retry session creation to finish them.`,
        );
        return;
      }
      setDecisionState("done");
      // Keep the selection through this reload too: the issue's acceptance criteria explicitly
      // treats checked rows as in-progress organizer state, including after a bulk action.
      decisionFeedback.announce(
        "success",
        only
          ? outcome === "accepted"
            ? `“${only.title}” is accepted. It is now a session in Sessions & speakers with ${only.submitter?.name ?? only.submitterName} linked as its speaker.`
            : `“${only.title}” is declined. The outcome is recorded against this abstract.`
          : outcome === "accepted"
            ? `${proposals.length} abstracts are accepted. Each is now a session in Sessions & speakers with its own submitter linked as its speaker.`
            : `${proposals.length} abstracts are declined. The outcome is recorded against each of them.`,
      );
    } catch (reason) {
      setDecisionErrors(fieldErrorsOf(reason));
      // ERROR-INTENT: the confirmation panel reports the handled failure in its own live region.
      decisionFeedback.announce(
        "error",
        message(
          reason,
          only
            ? `“${only.title}” could not be decided. Please retry.`
            : `${proposals.length} abstracts could not be decided. Please retry.`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;

  if (!data)
    return (
      <>
        <Card tight>
          <div className="triage-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="skeleton" style={{ height: 18 }} />
            ))}
          </div>
        </Card>
        <p className="visually-hidden" role="status">
          Loading abstract triage.
        </p>
      </>
    );

  const counts = new Map<string, number>();
  for (const proposal of data.proposals)
    counts.set(proposal.status, (counts.get(proposal.status) ?? 0) + 1);

  const tabs = [
    { id: "all", label: "All", count: data.proposals.length },
    ...data.statuses.map((status) => ({
      id: status.key,
      label: status.label,
      count: counts.get(status.key) ?? 0,
    })),
  ];
  const activeTab = tabs.some(({ id }) => id === tab) ? tab : "all";
  const open = data.proposals.find(({ id }) => id === openId) ?? null;
  const decisions = data.decisions ?? [];
  const decisionFor = (proposalId: string) =>
    decisions.find((decision) => decision.proposalId === proposalId);
  const openDecision = open ? decisionFor(open.id) : undefined;
  // Resolved from the whole set, not from the visible rows: accepting moves an abstract out of
  // the tab it was decided from, and the confirmation — with its live region — must survive that.
  const pendingProposals = pending
    ? pending.proposalIds.flatMap(
        (id) => data.proposals.find((proposal) => proposal.id === id) ?? [],
      )
    : [];
  const pendingDecisions = new Map(
    pendingProposals.flatMap((proposal) => {
      const recorded = decisionFor(proposal.id);
      return recorded ? [[proposal.id, recorded] as const] : [];
    }),
  );
  // History can name a status the organizer has since renamed or removed.
  const labelFor = (key: string) =>
    data.statuses.find((status) => status.key === key)?.label ?? key.replaceAll("_", " ");
  const allVisibleSelected = rows.length > 0 && rows.every(({ id }) => selected.includes(id));

  /*
   * Who is already reviewing an abstract is not the same question as who may be given one.
   *
   * `data.reviewers` is the *assignable* list and deliberately withholds the signed-in
   * organizer, so resolving an existing assignment's name through it printed a raw user id
   * ("seed-organizer") in the Reviewers column for every assignment the viewer could not have
   * made herself. `reviewerDirectory` is every reviewer of the event and is what a name is
   * looked up in; the fallback covers a server that predates the field.
   */
  const directory = data.reviewerDirectory ?? data.reviewers;
  const reviewerName = (reviewerId: string) => memberName(reviewerId, directory, currentActor);
  const assignmentsFor = (proposalId: string) =>
    data.assignments.filter((assignment) => assignment.proposalId === proposalId);

  const transition = (proposalIds: string[], toStatus: string, _clearSelection: boolean) => {
    const label = labelFor(toStatus);
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => transitionProposals(eventId, { proposalIds, toStatus }),
      `${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"} moved to ${label}.`,
    );
  };
  /**
   * Open the confirmation over a set of abstracts.
   *
   * Every accept and decline in this workspace goes through here, whether it started on one row
   * or on the bulk bar, because the decision — not the status — is what the programme acts on.
   */
  const openDecisionFor = (proposalIds: readonly string[], outcome: DecisionOutcome) => {
    setDecisionErrors({});
    setDecisionState("open");
    decisionFeedback.clear();
    setPending({ proposalIds, outcome });
  };
  const assign = (proposalIds: string[], reviewerId: string, _clearSelection: boolean) => {
    const name = reviewerName(reviewerId);
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => assignReviewer(eventId, { proposalIds, reviewerId }),
      `${name} is now reviewing ${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"}.`,
    );
  };
  const distribute = (proposalIds: string[]) => {
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () =>
        distributeReviewers(eventId, {
          proposalIds,
          reviewerIds: data.reviewers.map(({ id }) => id),
          maxAssignmentsPerReviewer: 20,
        }),
      `${proposalIds.length} abstracts distributed across the reviewer team.`,
    );
  };
  const startNextRound = () => {
    const fromStatus = data.statuses.find(({ key }) => key === activeTab)?.key;
    if (!fromStatus) {
      feedback.announce("error", "Choose one status tab before starting the next round.");
      return;
    }
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () =>
        advanceReviewRound(eventId, {
          fromStatus,
          reviewerIds: data.reviewers.map(({ id }) => id),
          maxAssignmentsPerReviewer: 20,
          currentRound: Math.max(0, ...data.assignments.map(({ round }) => round)),
        }),
      `Proposals in ${labelFor(fromStatus)} advanced to the next review round.`,
    );
  };
  const exportCsv = () => {
    const quote = (value: unknown) => {
      const raw = String(value ?? "");
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const criteria = data.plan?.criteria ?? [];
    const lines = [
      [
        "Proposal",
        "Submitter",
        "Co-authors",
        "Status",
        "Round",
        "Reviewer",
        "State",
        "Aggregate",
        ...criteria.map(({ name }) => name),
      ]
        .map(quote)
        .join(","),
    ];
    for (const proposal of data.proposals) {
      const assigned = assignmentsFor(proposal.id);
      if (!assigned.length)
        lines.push(
          [
            proposal.title,
            proposal.submitterName,
            (proposal.coAuthors ?? []).map(({ name, role }) => `${name} (${role})`).join("; "),
            proposal.status,
            "",
            "",
            "unassigned",
            "",
            ...criteria.map(() => ""),
          ]
            .map(quote)
            .join(","),
        );
      for (const assignment of assigned) {
        const evaluation = data.evaluations?.find((item) => item.assignmentId === assignment.id);
        const outcome = data.outcomes.find(
          (item) => item.proposalId === proposal.id && item.round === assignment.round,
        );
        lines.push(
          [
            proposal.title,
            proposal.submitterName,
            (proposal.coAuthors ?? []).map(({ name, role }) => `${name} (${role})`).join("; "),
            proposal.status,
            assignment.round,
            reviewerName(assignment.reviewerId),
            evaluation?.state ?? "outstanding",
            outcome?.averageScore ?? "",
            ...criteria.map((criterion) =>
              (() => {
                const score = evaluation?.scores.find((item) => item.criterionId === criterion.id);
                return score?.value ?? score?.score ?? "";
              })(),
            ),
          ]
            .map(quote)
            .join(","),
        );
      }
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    link.download = `review-results-${eventId}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  /**
   * Undo one assignment.
   *
   * Not routed through `act` because the envelope message for a refusal here — "The review
   * request is invalid." — is not something an organizer can act on; the sentence that is
   * lives in the field errors, so it is what gets announced.
   */
  const unassign = async (assignment: Assignment, title: string) => {
    const name = reviewerName(assignment.reviewerId);
    // Counted before the request: the rubric lock is "any assignment exists", so removing the
    // only one is also the moment the criteria stop being frozen — worth saying, because that
    // consequence is the half of this defect an organizer would never guess at.
    const unlocks = data.assignments.length === 1 && Boolean(data.plan);
    setBusy(true);
    try {
      await removeReviewAssignment(eventId, assignment.id);
      await load();
      feedback.announce(
        "success",
        `${name} is no longer reviewing “${title}”.${
          unlocks ? " That was the last assignment, so the evaluation criteria unlock." : ""
        }`,
      );
    } catch (reason) {
      const detail = Object.values(fieldErrorsOf(reason)).flat();
      // ERROR-INTENT: the triage live region reports the handled failure.
      feedback.announce(
        "error",
        detail.length
          ? `${name} could not be unassigned from “${title}”. ${detail.join(" ")}`
          : message(reason, `${name} could not be unassigned from “${title}”. Please retry.`),
      );
    } finally {
      setBusy(false);
    }
  };
  /*
   * The assigned reviewers of one abstract, each with the control that takes the assignment
   * back. A plain function rather than a nested component: a component declared in this body is
   * a new type on every render, so React would remount the list after each reload and the
   * keyboard would be dropped out of the button that was just pressed.
   */
  const assignedReviewers = (proposal: Proposal) => {
    const assigned = assignmentsFor(proposal.id);
    if (!assigned.length) return <span className="empty-text">Unassigned</span>;
    return (
      <ul className="assigned-reviewers">
        {assigned.map((assignment) => (
          <li key={assignment.id}>
            <span className="assigned-name">
              {reviewerName(assignment.reviewerId)} · round {assignment.round}
            </span>
            <button
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; unassign announces every outcome.
                void unassign(assignment, proposal.title);
              }}
            >
              Unassign
              {/* Every row carries this control, so the visible label alone would name a
                  dozen identical buttons to a screen reader. */}
              <span className="visually-hidden">
                {" "}
                {reviewerName(assignment.reviewerId)} from {proposal.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      {loading ? <p role="status">Updating abstract triage…</p> : null}
      <div className="triage-status-filters">
        <Tabs
          items={tabs}
          active={activeTab}
          onSelect={setTab}
          label="Filter abstracts by status"
        />
      </div>

      <div
        className="triage-panel"
        id={`panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
      >
        <Card tight>
          <div className="toolbar triage-toolbar">
            <div className="field triage-search">
              <label htmlFor="triage-search">Search abstracts</label>
              <input
                id="triage-search"
                type="search"
                value={search}
                placeholder="Title, submitter, or answer text"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <p className="triage-count">
              Showing {rows.length} of {data.proposals.length}
            </p>
            <button
              type="button"
              className="secondary small"
              onClick={() => setSortByScore((value) => !value)}
            >
              {sortByScore ? "Use submission order" : "Sort by aggregate"}
            </button>
            <button type="button" className="secondary small" onClick={exportCsv}>
              Export CSV
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={busy || activeTab === "all" || !data.reviewers.length}
              onClick={startNextRound}
            >
              Start next round
            </button>
          </div>

          {selected.length ? (
            <fieldset className="triage-bulk">
              <legend className="visually-hidden">Actions for the selected abstracts</legend>
              <p className="selection-count">
                {selected.length} selected
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => setSelected([])}
                  disabled={busy}
                >
                  Clear
                </button>
              </p>
              <ProposalActions
                idPrefix="bulk"
                statusLabel="Move selection to"
                reviewerLabel="Assign selection to"
                statuses={data.statuses}
                reviewers={data.reviewers}
                busy={busy}
                onTransition={(toStatus) => transition(selected, toStatus, true)}
                onAssign={(reviewerId) => assign(selected, reviewerId, true)}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy || !data.reviewers.length}
                onClick={() => distribute(selected)}
              >
                Distribute selection
              </button>
              {/*
               * The bulk accept an organizer was reaching for when they picked "Accepted" in the
               * pipeline select. It opens the same confirmation a single row does and posts the
               * same decision route, which takes the whole selection in one request — so the
               * selection ends up with recorded decisions and real sessions, not a green pill.
               */}
              <fieldset className="field triage-decide">
                {/* Each button names what it decides, so the legend is the visual grouping
                    rather than the only thing that identifies them. */}
                <legend className="group-label">Decide selection</legend>
                <div className="triage-action-row">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => openDecisionFor(selected, "accepted")}
                  >
                    Accept selection
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => openDecisionFor(selected, "declined")}
                  >
                    Decline selection
                  </button>
                </div>
              </fieldset>
            </fieldset>
          ) : null}

          <div className="triage-feedback">{feedback.node}</div>

          {rows.length === 0 ? (
            <EmptyState
              title={
                data.proposals.length
                  ? "No abstracts match this view"
                  : "No abstracts submitted yet"
              }
              icon={<IconInbox size={20} />}
            >
              {data.proposals.length
                ? "Clear the search box or choose another status tab."
                : "Submissions from the published call for proposals land here for triage."}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data triage-table">
                <thead>
                  <tr>
                    <th scope="col" className="select-cell">
                      <input
                        type="checkbox"
                        aria-label="Select every abstract in this view"
                        checked={allVisibleSelected}
                        onChange={(event) =>
                          setSelected(event.target.checked ? rows.map(({ id }) => id) : [])
                        }
                      />
                    </th>
                    <th scope="col">Abstract</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reviewers</th>
                    <th scope="col" className="num">
                      Score
                    </th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((proposal) => {
                    const outcome = data.outcomes.find(
                      ({ proposalId }) => proposalId === proposal.id,
                    );
                    const decided = decisionFor(proposal.id);
                    return (
                      <tr key={proposal.id} className={proposal.id === openId ? "is-open" : ""}>
                        <td className="select-cell" data-label="Select">
                          <input
                            type="checkbox"
                            aria-label={`Select ${proposal.title}`}
                            checked={selected.includes(proposal.id)}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, proposal.id]
                                  : current.filter((id) => id !== proposal.id),
                              )
                            }
                          />
                        </td>
                        <td className="primary-cell" data-label="Abstract">
                          <button
                            type="button"
                            className="cell-link"
                            aria-expanded={proposal.id === openId}
                            aria-controls="proposal-detail"
                            onClick={() =>
                              setOpenId((current) => (current === proposal.id ? null : proposal.id))
                            }
                          >
                            {proposal.title}
                          </button>
                          <span className="sub">
                            {proposal.submitterName}
                            {proposal.submitter ? ` · ${proposal.submitter.email}` : ""}
                          </span>
                        </td>
                        <td data-label="Status">
                          <Pill tone={statusTone(proposal.status)}>
                            {labelFor(proposal.status)}
                          </Pill>
                        </td>
                        <td data-label="Reviewers">{assignedReviewers(proposal)}</td>
                        <td className="num" data-label="Score">
                          {outcome ? (
                            <>
                              {outcome.averageScore.toFixed(1)}
                              <span className="sub">
                                {outcome.completedEvaluationCount} completed
                              </span>
                            </>
                          ) : (
                            <span className="empty-text">Not scored</span>
                          )}
                        </td>
                        <td className="decision-cell" data-label="Decision">
                          {decided ? (
                            <Pill tone={decided.outcome === "accepted" ? "ok" : "danger"}>
                              {OUTCOME_LABEL[decided.outcome]}
                            </Pill>
                          ) : null}
                          {/*
                           * Only the outcomes that would change something. A row already
                           * recorded as accepted offered "Accept" beside an "Accepted" pill,
                           * which reads as an available action and does nothing — and the
                           * reverse, declining an acceptance, is offered because it is a real
                           * correction, with the dialog stating that the session it created
                           * is not withdrawn by it.
                           */}
                          <span className="decision-buttons">
                            {(["accepted", "declined"] as const)
                              .filter((choice) => decided?.outcome !== choice)
                              .map((choice) => (
                                <button
                                  key={choice}
                                  type="button"
                                  className={choice === "accepted" ? "small" : "secondary small"}
                                  aria-haspopup="dialog"
                                  disabled={busy}
                                  onClick={() => openDecisionFor([proposal.id], choice)}
                                >
                                  {decided
                                    ? choice === "accepted"
                                      ? "Accept instead"
                                      : "Decline instead"
                                    : choice === "accepted"
                                      ? "Accept"
                                      : "Decline"}
                                  <span className="visually-hidden"> {proposal.title}</span>
                                </button>
                              ))}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/*
       * A decision is a modal question, so it is asked in a modal dialog.
       *
       * This used to render as a block appended after the table. The control that opened it sat
       * in a dense row near the top of the page and the panel appeared several hundred pixels
       * below, so clicking Accept looked like it had done nothing at all — the first thing every
       * reader of this screen reported. `<dialog showModal>` puts the question over the table
       * where the eye already is, and brings the focus trap, the inert backdrop, and Escape with
       * it rather than reimplementing three accessibility behaviours by hand.
       */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard equivalent of dismissing by
          clicking the backdrop is Escape, which `<dialog>` raises as `cancel` and `onCancel`
          already handles. A keyboard user never reaches the backdrop itself — the element is
          modal, so focus is trapped inside the card. */}
      <dialog
        className="decision-dialog"
        ref={decisionDialog}
        onCancel={closeDecision}
        // The backdrop is part of the dialog element, so a click that lands on the element
        // itself rather than on the card inside it is a click outside the question.
        onClick={(event) => {
          if (event.target === decisionDialog.current) closeDecision();
        }}
      >
        {pending && pendingProposals.length ? (
          <Card
            labelledBy="proposal-decision-title"
            // The dialog's own name says which decision it is for and stays put across the
            // outcome; what changes is the question inside it, which stops being a question
            // once it has been answered.
            title={
              pendingProposals.length === 1
                ? pending.outcome === "accepted"
                  ? "Accept this abstract"
                  : "Decline this abstract"
                : pending.outcome === "accepted"
                  ? "Accept these abstracts"
                  : "Decline these abstracts"
            }
            hint={
              decisionState === "done"
                ? "Stored with who decided and when."
                : "Accepting records the decision and creates the session in one step; declining records the decision only."
            }
          >
            <DecisionForm
              // Remount per set and per outcome so the note never carries over from the
              // abstracts or the outcome the organizer was looking at a moment ago.
              key={`${pending.proposalIds.join(",")}:${pending.outcome}`}
              proposals={pendingProposals}
              outcome={pending.outcome}
              recorded={pendingDecisions}
              state={decisionState}
              busy={busy}
              errors={decisionErrors}
              feedback={decisionFeedback}
              onConfirm={(note) => {
                // ERROR-INTENT: React event handlers cannot await; decide announces every outcome.
                void decide(pendingProposals, pending.outcome, note);
              }}
              onClose={closeDecision}
            />
          </Card>
        ) : null}
      </dialog>

      {open ? (
        // The wrapper is only a focus target; the card inside carries the accessible name.
        <div className="proposal-detail" id="proposal-detail" ref={detailRef} tabIndex={-1}>
          <Card
            labelledBy="proposal-detail-title"
            title={open.title}
            hint={`Submitted by ${open.submitterName}`}
            actions={
              <>
                <Pill tone={statusTone(open.status)}>{labelFor(open.status)}</Pill>
                <button type="button" className="secondary small" onClick={() => setOpenId(null)}>
                  Close
                </button>
              </>
            }
          >
            <ProposalAnswers answers={open.answers} />
            {(open.coAuthors ?? []).length ? (
              <p className="detail-reviewers">
                <span className="detail-term">Co-authors and presenters</span>
                {(open.coAuthors ?? []).map(({ name, role }) => `${name} — ${role}`).join(", ")}
              </p>
            ) : null}
            {/* Organizers see the contact address; the reviewer queue never receives it. */}
            <p className="detail-reviewers">
              <span className="detail-term">Submitter</span>
              {open.submitterName}
              {open.submitter ? (
                <>
                  {" · "}
                  <a href={`mailto:${open.submitter.email}`}>{open.submitter.email}</a>
                </>
              ) : (
                <span className="empty-text"> · no contact address on this submission</span>
              )}
            </p>
            {openDecision ? (
              <p className="detail-reviewers">
                <span className="detail-term">Decision</span>
                {OUTCOME_LABEL[openDecision.outcome]}
                {openDecision.note ? ` — ${openDecision.note}` : ""}
              </p>
            ) : null}
            <div className="detail-reviewers">
              <span className="detail-term">Assigned reviewers</span>
              {assignmentsFor(open.id).length ? (
                assignedReviewers(open)
              ) : (
                <span className="empty-text">Nobody yet</span>
              )}
            </div>
            <ProposalActions
              // Remount per proposal: the status select seeds from currentStatus, so
              // reusing the instance left the previous abstract's status preselected
              // and a single "Move" click would send it somewhere nobody chose.
              key={open.id}
              idPrefix="detail"
              statusLabel="Move this abstract to"
              reviewerLabel="Assign this abstract to"
              statuses={data.statuses}
              reviewers={data.reviewers}
              currentStatus={open.status}
              busy={busy}
              onTransition={(toStatus) => transition([open.id], toStatus, false)}
              onAssign={(reviewerId) => assign([open.id], reviewerId, false)}
            />
          </Card>
        </div>
      ) : null}

      <details className="review-setup">
        <summary>
          Evaluation setup
          <span className="setup-summary-hint">Scoring criteria and the status pipeline</span>
        </summary>
        <div className="review-setup-body">
          <RubricForm
            eventId={eventId}
            data={data}
            onSaved={async () => {
              await load();
            }}
          />
          <StatusForm
            eventId={eventId}
            data={data}
            onSaved={async () => {
              await load();
            }}
          />
        </div>
      </details>

      <div className="review-block">
        <Card
          labelledBy="review-progress"
          title="Reviewer progress"
          hint="Assigned, completed, and outstanding evaluations by reviewer."
        >
          {(data.progress ?? []).some(({ outstanding }) => outstanding > 0) ? (
            <>
              <ul className="assigned-reviewers">
                {(data.progress ?? []).map((item) => (
                  <li key={item.reviewerId}>
                    {reviewerName(item.reviewerId)} — {item.assigned} assigned · {item.completed}{" "}
                    completed · {item.outstanding} outstanding
                  </li>
                ))}
              </ul>
              <p className="hint">Reminder emails to reviewers aren’t available yet.</p>
            </>
          ) : (
            <EmptyState title="No outstanding reviews" icon={<IconReview size={20} />}>
              Every assigned evaluation is complete.
            </EmptyState>
          )}
        </Card>
      </div>

      <div className="review-block">
        <Card
          labelledBy="status-audit"
          title="Status history"
          hint={
            data.audit.length > RECENT_CHANGES
              ? `The ${RECENT_CHANGES} most recent of ${data.audit.length} recorded transitions.`
              : "Every recorded transition, most recent first."
          }
          tight
        >
          {data.audit.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Abstract</th>
                    <th scope="col">Change</th>
                    <th scope="col">By</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.slice(0, RECENT_CHANGES).map((entry) => (
                    <tr key={entry.id}>
                      <td className="primary-cell">
                        {data.proposals.find(({ id }) => id === entry.proposalId)?.title ??
                          entry.proposalId}
                      </td>
                      <td>
                        {labelFor(entry.fromStatus)} → {labelFor(entry.toStatus)}
                      </td>
                      <td>{reviewerName(entry.actorId)}</td>
                      <td>{new Date(entry.occurredAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No status changes yet" icon={<IconReview size={20} />}>
              Moving an abstract through the pipeline records who changed it and when.
            </EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
