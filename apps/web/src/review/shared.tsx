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
} from "@greenroom/contracts";
import { Fragment } from "react";
import { ReviewApiError } from "../api/review";
import "../styles/review.css";

type Proposal = OrganizerReviewWorkspaceDto["proposals"][number];
type Answer = Proposal["answers"][number];
type StatusDefinition = OrganizerReviewWorkspaceDto["statuses"][number];
type Reviewer = OrganizerReviewWorkspaceDto["reviewers"][number];
type Assignment = OrganizerReviewWorkspaceDto["assignments"][number];
type Decision = NonNullable<OrganizerReviewWorkspaceDto["decisions"]>[number];
type DecisionOutcome = Decision["outcome"];
type Round = NonNullable<OrganizerReviewWorkspaceDto["rounds"]>[number];
type Evaluation = NonNullable<OrganizerReviewWorkspaceDto["evaluations"]>[number];
type PillTone = "neutral" | "ok" | "warn" | "danger" | "info" | "strong";

/** How a round's lifecycle reads on screen, and what colour says so. */
const ROUND_STATE: Record<Round["state"], { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Open", tone: "ok" },
  closed: { label: "Closed", tone: "info" },
};

/** A date-only rendering of an ISO instant, or a dash when the round is unbounded on that side. */
const roundDate = (instant: string | null) =>
  instant ? new Date(instant).toLocaleDateString() : "—";

/**
 * The rubric a round is actually scored against.
 *
 * The same fallback the server applies, restated here because the console renders criterion names
 * beside stored scores and a round with its own scorecard must not be labelled with the event
 * plan's criteria. Mirrors `roundCriteria` in the review domain.
 */
const criteriaOf = (
  round: Round | undefined,
  plan: OrganizerReviewWorkspaceDto["plan"],
): readonly NonNullable<Round["criteria"]>[number][] => round?.criteria ?? plan?.criteria ?? [];

/**
 * A hub destination that keeps whichever event the console is on.
 *
 * The console's addresses are `/<hub>?tab=<tab>&event=<id>`, and the event parameter is the
 * shell's, not this domain's — so it is carried over from the address already open rather than
 * threaded through every component that wants to offer a link. Built here because two review
 * surfaces need it and neither owns the router.
 */
function hubHref(path: string, tab: string): string {
  const params = new URLSearchParams(window.location.search);
  const event = params.get("event");
  const next = new URLSearchParams({ tab });
  if (event) next.set("event", event);
  return `${path}?${next.toString()}`;
}

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
  waitlisted: "Waitlisted",
  revision_requested: "Revision requested",
  declined: "Declined",
};
const OUTCOME_ACTION: Record<DecisionOutcome, string> = {
  accepted: "Accept",
  waitlisted: "Waitlist",
  revision_requested: "Request revision",
  declined: "Decline",
};
const OUTCOME_NOUN: Record<DecisionOutcome, string> = {
  accepted: "acceptance",
  waitlisted: "waitlisting",
  revision_requested: "revision request",
  declined: "decline",
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

export type { DecisionState } from "./DecisionForm";
export { DecisionForm } from "./DecisionForm";
export { ProposalActions } from "./ProposalActions";
export type {
  Assignment,
  Decision,
  DecisionOutcome,
  Evaluation,
  PillTone,
  Proposal,
  Reviewer,
  Round,
  StatusDefinition,
};
export {
  criteriaOf,
  DECISION_STATUS_KEYS,
  fieldErrorsOf,
  hubHref,
  listTitles,
  message,
  OUTCOME_LABEL,
  OUTCOME_ACTION,
  OUTCOME_NOUN,
  ProposalAnswers,
  ROUND_STATE,
  roundDate,
  statusTone,
};
