/*
 * Abstract triage (organizer) and the reviewer scoring queue.
 *
 * Triage leads on the organizer surface: statuses are tabs with counts, the
 * proposal table is the page, and the evaluation plan plus status pipeline are
 * folded into a secondary "Evaluation setup" panel — configuration is a rare act,
 * triage is the daily one. The reviewer surface inverts the old order so the
 * assigned proposal and its scoring form are the first thing on screen.
 */

import type { OrganizerReviewWorkspaceDto, ReviewerQueueDto } from "@greenroom/contracts";
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignReviewer,
  configureProposalStatuses,
  configureReviewPlan,
  declareReviewConflict,
  getOrganizerReview,
  getReviewerQueue,
  ReviewApiError,
  recordProposalDecision,
  saveReviewEvaluation,
  transitionProposals,
} from "./api/review";
import "./styles/review.css";
import { IconCheck, IconInbox, IconPlus, IconReview, IconWarning } from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "./ui/primitives";

type Proposal = OrganizerReviewWorkspaceDto["proposals"][number];
type Answer = Proposal["answers"][number];
type StatusDefinition = OrganizerReviewWorkspaceDto["statuses"][number];
type Reviewer = OrganizerReviewWorkspaceDto["reviewers"][number];
type Decision = NonNullable<OrganizerReviewWorkspaceDto["decisions"]>[number];
type DecisionOutcome = Decision["outcome"];
type PillTone = "neutral" | "ok" | "warn" | "danger" | "info" | "strong";

/** A handled API failure, with the reference an organizer can quote when reporting it. */
const message = (error: unknown, fallback = "Review work could not be loaded. Please retry.") =>
  error instanceof ReviewApiError
    ? `${error.message} Reference: ${error.envelope.error.correlationId}`
    : fallback;

/** Field-level detail the server attached to a handled failure. */
const fieldErrorsOf = (error: unknown): Record<string, string[]> =>
  error instanceof ReviewApiError ? (error.envelope.error.fieldErrors ?? {}) : {};

const OUTCOME_LABEL: Record<DecisionOutcome, string> = {
  accepted: "Accepted",
  declined: "Declined",
};

/** Status keys are configurable, so tone falls back to neutral for anything bespoke. */
function statusTone(key: string): PillTone {
  if (/accept|approved/.test(key)) return "ok";
  if (/declin|reject|withdraw/.test(key)) return "danger";
  if (/review/.test(key)) return "warn";
  if (/submit|new|pending/.test(key)) return "info";
  return "neutral";
}

/**
 * Submitted answers carry the CFP field's configured label, but proposals captured
 * before the form snapshot existed fall back to the raw field id ("abstract").
 * Present those as a readable label instead of leaking storage keys into the UI.
 */
function answerLabel({ fieldId, label }: Pick<Answer, "fieldId" | "label">) {
  const text = (label.trim() || fieldId).replaceAll(/[_-]+/g, " ");
  const looksLikeIdentifier = text === text.toLowerCase() && /^[a-z0-9 ]+$/.test(text);
  return looksLikeIdentifier ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function ProposalAnswers({ answers }: { answers: readonly Answer[] }) {
  if (!answers.length) return <p className="empty-text">This submission has no answers.</p>;
  return (
    // dt/dd stay direct children so the shared two-column answer grid lines up.
    <dl className="proposal-answers">
      {answers.map((answer) => (
        <Fragment key={answer.fieldId}>
          <dt>{answerLabel(answer)}</dt>
          <dd>{answer.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Status and reviewer controls, shared by the bulk bar and the single-proposal
 * detail panel. Both act on a list of proposal ids, so the only difference is the
 * wording and how many rows are in that list.
 */
function ProposalActions({
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
  const [status, setStatus] = useState(currentStatus ?? statuses[0]?.key ?? "");
  const [reviewerId, setReviewerId] = useState("");
  useEffect(() => {
    // Organizers can rename or delete statuses while this control is mounted.
    if (!statuses.some(({ key }) => key === status)) setStatus(statuses[0]?.key ?? "");
  }, [statuses, status]);
  return (
    <div className="triage-actions">
      <div className="field">
        <label htmlFor={`${idPrefix}-status`}>{statusLabel}</label>
        <div className="triage-action-row">
          <select
            id={`${idPrefix}-status`}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {statuses.map((definition) => (
              <option key={definition.key} value={definition.key}>
                {definition.label}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !status} onClick={() => onTransition(status)}>
            Move
          </button>
        </div>
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
 * The confirmation an accept or decline opens on its own row.
 *
 * It names the proposal being decided and, for an acceptance, the person who will become the
 * session's speaker — the organizer is authorizing content, not flipping a status, so the
 * resolved title and submitter have to be on screen before they confirm. Field-level failures
 * from either domain render against the control that produced them rather than at the top of
 * the page, and the panel stays mounted afterwards so its live region survives the outcome.
 */
function DecisionForm({
  proposal,
  outcome,
  decided,
  busy,
  errors,
  feedback,
  onConfirm,
  onClose,
}: {
  proposal: Proposal;
  outcome: DecisionOutcome;
  decided: Decision | undefined;
  busy: boolean;
  errors: Record<string, string[]>;
  feedback: ReturnType<typeof useActionFeedback>;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(decided?.note ?? "");
  const panel = useRef<HTMLDivElement>(null);
  const noteId = `decision-note-${proposal.id}`;
  const reasonId = `decision-reason-${proposal.id}`;
  /**
   * Acceptance provisions a speaker from the submitter's contact address, so a submission that
   * carries none cannot be accepted at all. Offering an enabled Confirm here only produced a
   * recorded decision the content domain then refused; the control says why instead.
   */
  const unacceptable = outcome === "accepted" && !proposal.submitter;
  // Same rule as the detail panel: the surface the action opened takes focus, so the
  // keyboard lands on what it just summoned instead of staying behind in the table.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const listed = Object.entries(errors).flatMap(([field, messages]) =>
    messages.map((text) => ({ key: `${field}:${text}`, text })),
  );

  return (
    <div className="decision-confirm" ref={panel} tabIndex={-1}>
      <p className="decision-question">
        {outcome === "accepted" ? "Accept" : "Decline"} <strong>{proposal.title}</strong>?
      </p>
      <p className="hint" id={reasonId}>
        {outcome === "accepted"
          ? proposal.submitter
            ? `Creates a session from this abstract and links ${proposal.submitter.name} (${proposal.submitter.email}) as its speaker.`
            : "This submission carries no contact address, so no speaker can be created from it and it cannot be accepted. Ask the submitter for an address, or add an email field to the published form and have them resubmit."
          : `Records the outcome against ${proposal.submitterName} and moves the abstract to Declined. Nothing is sent to the submitter.`}
      </p>
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
          {outcome === "accepted" ? "Confirm acceptance" : "Confirm decline"}
        </button>
        <button
          type="button"
          className="ghost"
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
        {decided ? (
          <span className="hint">
            Already recorded as {OUTCOME_LABEL[decided.outcome].toLowerCase()} by{" "}
            {decided.decidedBy}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The audit grows without bound; triage only needs the tail of it on screen. */
const RECENT_CHANGES = 12;

// @spec PRD-ABS-001 PRD-REV-001
export function OrganizerReviewWorkspace({ eventId }: { eventId: string }) {
  const [data, setData] = useState<OrganizerReviewWorkspaceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which row has its accept/decline confirmation open, and what it would record.
  const [pending, setPending] = useState<{ proposalId: string; outcome: DecisionOutcome } | null>(
    null,
  );
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string[]>>({});
  const feedback = useActionFeedback();
  const decisionFeedback = useActionFeedback();
  const detailRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // The tab strip needs a count for every status in one paint, so the workspace
    // loads the whole set once and narrows it in the client.
    setData(await getOrganizerReview(eventId));
  }, [eventId]);

  useEffect(() => {
    setData(null);
    setSelected([]);
    setOpenId(null);
    setPending(null);
    setError(null);
    // ERROR-INTENT: React effects cannot await; the rejection renders in this workspace.
    void load().catch((reason: unknown) => setError(message(reason)));
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.proposals.filter((proposal) => {
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
  }, [data, search, tab]);

  useEffect(() => {
    // Never act on a row the organizer can no longer see.
    const visible = new Set(rows.map(({ id }) => id));
    setSelected((current) => {
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [rows]);

  useEffect(() => {
    if (openId) detailRef.current?.focus();
  }, [openId]);

  async function act(action: () => Promise<unknown>, success: string, clearSelection: boolean) {
    setBusy(true);
    try {
      await action();
      if (clearSelection) setSelected([]);
      await load();
      feedback.announce("success", success);
    } catch (reason) {
      feedback.announce("error", message(reason));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Decide one abstract.
   *
   * One request: the server records the decision and, for an acceptance, creates the session in
   * the same call. This workspace does not reach into the content domain to finish the job — it
   * could not have made that pair atomic anyway, and a failure between the two calls used to
   * leave an abstract recorded as accepted with no session and no way to repair it from here.
   * The response says which half happened; when the session is missing the decision still
   * stands, so Confirm doubles as Retry.
   */
  async function decide(proposal: Proposal, outcome: DecisionOutcome, note: string) {
    setBusy(true);
    setDecisionErrors({});
    try {
      const result = await recordProposalDecision(eventId, {
        proposalIds: [proposal.id],
        outcome,
        note,
      });
      await load();
      // Absent for a decline, and — for a response that predates the composed route — absent for
      // an acceptance too, which is reported as unfinished rather than announced as done.
      const acceptance = (result.acceptances ?? []).find(
        ({ proposalId }) => proposalId === proposal.id,
      );
      if (outcome === "accepted" && acceptance?.state !== "content") {
        setDecisionErrors(acceptance?.fieldErrors ?? {});
        decisionFeedback.announce(
          "error",
          `The acceptance decision was recorded, but the session was not created. ${
            acceptance?.detail ?? "The server did not say what happened."
          } Confirm again to finish acceptance.`,
        );
        return;
      }
      decisionFeedback.announce(
        "success",
        outcome === "accepted"
          ? `“${proposal.title}” is accepted. It is now a session in Sessions & speakers with ${proposal.submitter?.name ?? proposal.submitterName} linked as its speaker.`
          : `“${proposal.title}” is declined. The outcome is recorded against this abstract.`,
      );
    } catch (reason) {
      setDecisionErrors(fieldErrorsOf(reason));
      // ERROR-INTENT: the confirmation panel reports the handled failure in its own live region.
      decisionFeedback.announce(
        "error",
        message(reason, `“${proposal.title}” could not be decided. Please retry.`),
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
  const pendingProposal = pending
    ? (data.proposals.find(({ id }) => id === pending.proposalId) ?? null)
    : null;
  // History can name a status the organizer has since renamed or removed.
  const labelFor = (key: string) =>
    data.statuses.find((status) => status.key === key)?.label ?? key.replaceAll("_", " ");
  const allVisibleSelected = rows.length > 0 && rows.every(({ id }) => selected.includes(id));

  const reviewersFor = (proposalId: string) =>
    data.assignments
      .filter((assignment) => assignment.proposalId === proposalId)
      .map(
        (assignment) =>
          data.reviewers.find(({ id }) => id === assignment.reviewerId)?.name ??
          assignment.reviewerId,
      );

  const transition = (proposalIds: string[], toStatus: string, clearSelection: boolean) => {
    const label = labelFor(toStatus);
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => transitionProposals(eventId, { proposalIds, toStatus }),
      `${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"} moved to ${label}.`,
      clearSelection,
    );
  };
  const assign = (proposalIds: string[], reviewerId: string, clearSelection: boolean) => {
    const name = data.reviewers.find(({ id }) => id === reviewerId)?.name ?? reviewerId;
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => assignReviewer(eventId, { proposalIds, reviewerId }),
      `${name} is now reviewing ${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"}.`,
      clearSelection,
    );
  };

  return (
    <>
      <Tabs items={tabs} active={activeTab} onSelect={setTab} label="Filter abstracts by status" />

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
                    const assigned = reviewersFor(proposal.id);
                    const decided = decisionFor(proposal.id);
                    return (
                      <tr key={proposal.id} className={proposal.id === openId ? "is-open" : ""}>
                        <td className="select-cell">
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
                        <td className="primary-cell">
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
                        <td>
                          <Pill tone={statusTone(proposal.status)}>
                            {labelFor(proposal.status)}
                          </Pill>
                        </td>
                        <td>
                          {assigned.length ? (
                            assigned.join(", ")
                          ) : (
                            <span className="empty-text">Unassigned</span>
                          )}
                        </td>
                        <td className="num">
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
                        <td className="decision-cell">
                          {decided ? (
                            <Pill tone={decided.outcome === "accepted" ? "ok" : "danger"}>
                              {OUTCOME_LABEL[decided.outcome]}
                            </Pill>
                          ) : null}
                          <span className="decision-buttons">
                            {(["accepted", "declined"] as const).map((choice) => (
                              <button
                                key={choice}
                                type="button"
                                className={choice === "accepted" ? "small" : "secondary small"}
                                aria-expanded={
                                  pending?.proposalId === proposal.id && pending.outcome === choice
                                }
                                aria-controls="proposal-decision"
                                disabled={busy}
                                onClick={() => {
                                  setDecisionErrors({});
                                  decisionFeedback.clear();
                                  setPending({ proposalId: proposal.id, outcome: choice });
                                }}
                              >
                                {choice === "accepted" ? "Accept" : "Decline"}
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

      {pending && pendingProposal ? (
        <div className="review-block" id="proposal-decision">
          <Card
            labelledBy="proposal-decision-title"
            title={
              pending.outcome === "accepted" ? "Accept this abstract" : "Decline this abstract"
            }
            hint="Accepting records the decision and creates the session in one step; declining records the decision only."
          >
            <DecisionForm
              // Remount per row and per outcome so the note never carries over from the
              // abstract or the outcome the organizer was looking at a moment ago.
              key={`${pending.proposalId}:${pending.outcome}`}
              proposal={pendingProposal}
              outcome={pending.outcome}
              decided={decisionFor(pending.proposalId)}
              busy={busy}
              errors={decisionErrors}
              feedback={decisionFeedback}
              onConfirm={(note) => {
                // ERROR-INTENT: React event handlers cannot await; decide announces every outcome.
                void decide(pendingProposal, pending.outcome, note);
              }}
              onClose={() => setPending(null)}
            />
          </Card>
        </div>
      ) : null}

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
            <p className="detail-reviewers">
              <span className="detail-term">Assigned reviewers</span>
              {reviewersFor(open.id).length ? (
                reviewersFor(open.id).join(", ")
              ) : (
                <span className="empty-text">Nobody yet</span>
              )}
            </p>
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
          <RubricForm eventId={eventId} data={data} onSaved={load} />
          <StatusForm eventId={eventId} data={data} onSaved={load} />
        </div>
      </details>

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
                      <td>{entry.actorId}</td>
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

function StatusForm({
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
      await configureProposalStatuses(eventId, { statuses: configured });
      edited.current = false;
      await onSaved();
      feedback.announce("success", "Proposal statuses saved.");
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
          cannot be removed.
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
        <button type="submit" disabled={busy}>
          Save statuses
        </button>
        <button type="button" className="ghost" onClick={reset} disabled={busy}>
          Discard changes
        </button>
      </div>
    </form>
  );
}

const NEW_CRITERION = () => ({
  id: `c_${crypto.randomUUID().replaceAll("-", "")}`,
  name: "",
  description: "",
  minScore: 1,
  maxScore: 5,
});

function RubricForm({
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
        <dl className="rubric-summary">
          {criteria.map((criterion) => (
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
    setError(null);
    // ERROR-INTENT: React effects cannot await; the rejection renders in this workspace.
    void load().catch((reason: unknown) => setError(message(reason)));
  }, [load]);

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
  const active =
    data.assignments.find(({ assignment }) => assignment.id === activeId) ??
    data.assignments.find((item) => item.evaluation?.state !== "completed" && !item.conflict) ??
    data.assignments[0];
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

function EvaluationCard({
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
