/*
 * Abstract triage (organizer) and the reviewer scoring queue.
 *
 * Triage leads on the organizer surface: statuses are tabs with counts, the
 * proposal table is the page, and the evaluation plan plus status pipeline are
 * folded into a secondary "Evaluation setup" panel — configuration is a rare act,
 * triage is the daily one. The reviewer surface inverts the old order so the
 * assigned proposal and its scoring form are the first thing on screen.
 */

import {
  type OrganizerReviewWorkspaceDto,
  proposalDecisionOutcomeSchema,
  type ReviewerQueueDto,
} from "@greenroom/contracts";
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
  removeReviewAssignment,
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
type Assignment = OrganizerReviewWorkspaceDto["assignments"][number];
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

/**
 * The two statuses a decision produces, which are therefore never a destination.
 *
 * `accepted` and `declined` are the review domain's reserved keys: an abstract arrives in one of
 * them *because* an accept or decline was recorded, and it is that stored decision — not the
 * status label — that authorizes the abstract to become a session (`PRD-REV-001`). Offering them
 * in the pipeline select made "Move selection to → Accepted" the only bulk accept on the screen,
 * and it wrote a status with no decision behind it: the board said Accepted, the Decision column
 * stayed empty, no session or speaker existed, and the content domain refused the very abstract
 * the board had turned green. The list is derived from the contract so the two cannot drift.
 */
const DECISION_STATUS_KEYS: ReadonlySet<string> = new Set<string>(
  proposalDecisionOutcomeSchema.options,
);

/** Titles as prose, with a tail count once the list would stop being readable. */
const listTitles = (proposals: readonly Proposal[], limit = 3) => {
  const titles = proposals.map(({ title }) => `“${title}”`);
  return titles.length <= limit
    ? titles.join(", ")
    : `${titles.slice(0, limit).join(", ")} and ${titles.length - limit} more`;
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
 *
 * The status select is the *pipeline*: the configurable steps an abstract moves through while it
 * is being triaged. The reserved decision keys are excluded (see `DECISION_STATUS_KEYS`) and the
 * hint says where they went, because a transition to one of them is a status change with no
 * decision behind it. Accepting and declining — one abstract or a whole selection — is the
 * Accept/Decline control and its confirmation.
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
type DecisionState = "open" | "retry" | "done";

/**
 * The confirmation an accept or decline opens, for one abstract or for a selection.
 *
 * It names what is being decided and, for an acceptance, who will become each session's speaker
 * — the organizer is authorizing content, not flipping a status, so the resolved titles and
 * submitters have to be on screen before they confirm. Field-level failures from either domain
 * render against the control that produced them rather than at the top of the page, and the
 * panel stays mounted afterwards so its live region survives the outcome.
 */
function DecisionForm({
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
      await load();
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
      // The rows have been decided, so the bulk bar's selection has done its work. Leaving it
      // standing invites a second decision on the same abstracts.
      if (!only) setSelected([]);
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
  const reviewerName = (reviewerId: string) =>
    directory.find(({ id }) => id === reviewerId)?.name ?? reviewerId;
  const assignmentsFor = (proposalId: string) =>
    data.assignments.filter((assignment) => assignment.proposalId === proposalId);

  const transition = (proposalIds: string[], toStatus: string, clearSelection: boolean) => {
    const label = labelFor(toStatus);
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => transitionProposals(eventId, { proposalIds, toStatus }),
      `${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"} moved to ${label}.`,
      clearSelection,
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
  const assign = (proposalIds: string[], reviewerId: string, clearSelection: boolean) => {
    const name = reviewerName(reviewerId);
    // ERROR-INTENT: React event handlers cannot await; act announces every outcome.
    void act(
      () => assignReviewer(eventId, { proposalIds, reviewerId }),
      `${name} is now reviewing ${proposalIds.length} abstract${proposalIds.length === 1 ? "" : "s"}.`,
      clearSelection,
    );
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
            <span className="assigned-name">{reviewerName(assignment.reviewerId)}</span>
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
                        <td>{assignedReviewers(proposal)}</td>
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
      const saved = await configureProposalStatuses(eventId, { statuses: configured });
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
