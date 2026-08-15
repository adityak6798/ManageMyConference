import {
  type ApiErrorEnvelope,
  advanceReviewRoundInputSchema,
  advanceReviewRoundResponseSchema,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  createReviewRoundInputSchema,
  distributeReviewersInputSchema,
  evaluationResponseSchema,
  remindReviewersInputSchema,
  remindReviewersResponseSchema,
  recomputeReviewRoundInputSchema,
  inviteReviewRoundInputSchema,
  inviteReviewRoundResponseSchema,
  reviewRoundResponseSchema,
  reviewRoundsResponseSchema,
  setReviewRoundPoolInputSchema,
  updateReviewRoundInputSchema,
  type OrganizerReviewWorkspaceDto,
  organizerReviewWorkspaceSchema,
  proposalDecisionResponseSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  type ReviewerQueueDto,
  recordProposalDecisionInputSchema,
  respondToSuggestionInputSchema,
  reviewAssignmentRemovalResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewerQueueSchema,
  reviewPlanResponseSchema,
  reviewSuggestionResponseSchema,
  type SaveEvaluationInput,
  saveEvaluationInputSchema,
  suggestionResponseResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ReviewApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}
async function decode<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  return decodeResponse(response, schema, (envelope) => new ReviewApiError(envelope));
}
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function getOrganizerReview(
  eventId: string,
  status?: string,
): Promise<OrganizerReviewWorkspaceDto> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return decode(
    await fetch(`/api/events/${eventId}/review/organizer${query}`),
    organizerReviewWorkspaceSchema,
  );
}
export async function configureProposalStatuses(
  eventId: string,
  input: z.input<typeof configureProposalStatusesInputSchema>,
) {
  const response = await fetch(`/api/events/${eventId}/review/statuses`, {
    ...json(configureProposalStatusesInputSchema.parse(input)),
    method: "PUT",
  });
  return decode(response, proposalStatusesResponseSchema);
}
export async function configureReviewPlan(
  eventId: string,
  input: z.input<typeof configureReviewPlanInputSchema>,
) {
  const response = await fetch(`/api/events/${eventId}/review/plan`, {
    ...json(configureReviewPlanInputSchema.parse(input)),
    method: "PUT",
  });
  return decode(response, reviewPlanResponseSchema);
}
export async function assignReviewer(
  eventId: string,
  input: z.input<typeof assignReviewersInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/assignments`,
      json(assignReviewersInputSchema.parse(input)),
    ),
    reviewAssignmentsResponseSchema,
  );
}
export async function distributeReviewers(
  eventId: string,
  input: z.input<typeof distributeReviewersInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/assignments/distribute`,
      json(distributeReviewersInputSchema.parse(input)),
    ),
    reviewAssignmentsResponseSchema,
  );
}
/** Every configured round of this event with its reviewer pool. */
export async function getReviewRounds(eventId: string) {
  return decode(
    await fetch(`/api/events/${eventId}/review/round-plans`),
    reviewRoundsResponseSchema,
  );
}
/**
 * Create a round.
 *
 * The sequence is not passed: the server allocates it, because it is the number every assignment,
 * outcome and suggestion of the round will carry and two clients picking it independently is how
 * two rounds end up claiming to be the same one.
 */
export async function createReviewRound(
  eventId: string,
  input: z.input<typeof createReviewRoundInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/round-plans`,
      json(createReviewRoundInputSchema.parse(input)),
    ),
    reviewRoundResponseSchema,
  );
}
export async function updateReviewRound(
  eventId: string,
  sequence: number,
  input: z.input<typeof updateReviewRoundInputSchema>,
) {
  const response = await fetch(`/api/events/${eventId}/review/round-plans/${sequence}`, {
    ...json(updateReviewRoundInputSchema.parse(input)),
    method: "PUT",
  });
  return decode(response, reviewRoundResponseSchema);
}
/**
 * Replace a round's reviewer pool.
 *
 * The whole list rather than add/remove, because "these are the reviewers of this round" is the
 * edit an organizer is making and two verbs would put a state nobody chose in between them.
 * Refused for a reviewer who already holds assignments in the round.
 */
export async function setReviewRoundPool(
  eventId: string,
  sequence: number,
  reviewerIds: readonly string[],
) {
  const response = await fetch(`/api/events/${eventId}/review/round-plans/${sequence}/pool`, {
    ...json(setReviewRoundPoolInputSchema.parse({ reviewerIds })),
    method: "PUT",
  });
  return decode(response, reviewRoundResponseSchema);
}
export async function recomputeReviewRound(
  eventId: string,
  sequence: number,
  input: z.input<typeof recomputeReviewRoundInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/round-plans/${sequence}/recompute`,
      json(recomputeReviewRoundInputSchema.parse(input)),
    ),
    reviewRoundResponseSchema,
  );
}

export async function inviteReviewRound(
  eventId: string,
  sequence: number,
  input: z.input<typeof inviteReviewRoundInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/round-plans/${sequence}/invitations`,
      json(inviteReviewRoundInputSchema.parse(input)),
    ),
    inviteReviewRoundResponseSchema,
  );
}
/**
 * Remind selected reviewers about their outstanding evaluations in a round.
 *
 * The response says what happened per reviewer — queued, already sent, unaddressable, or nothing
 * outstanding — because a request for four people where one has no linked address must not be
 * reported to the organizer as four messages sent.
 */
export async function remindReviewers(
  eventId: string,
  input: z.input<typeof remindReviewersInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/reminders`,
      json(remindReviewersInputSchema.parse(input)),
    ),
    remindReviewersResponseSchema,
  );
}
export async function advanceReviewRound(
  eventId: string,
  input: z.input<typeof advanceReviewRoundInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/rounds`,
      json(advanceReviewRoundInputSchema.parse(input)),
    ),
    advanceReviewRoundResponseSchema,
  );
}
/**
 * Remove one review assignment.
 *
 * The undo for an assignment that went to the wrong person. It is also what unlocks the
 * evaluation rubric, which stays frozen while any assignment exists — so the failure mode this
 * repairs is not only "the wrong reviewer has it" but "the criteria can never be edited again".
 * Refused once that reviewer has completed their evaluation.
 */
export async function removeReviewAssignment(eventId: string, assignmentId: string) {
  return decode(
    await fetch(`/api/events/${eventId}/review/assignments/${assignmentId}`, { method: "DELETE" }),
    reviewAssignmentRemovalResponseSchema,
  );
}
export async function transitionProposals(
  eventId: string,
  input: z.input<typeof bulkProposalTransitionInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/transitions`,
      json(bulkProposalTransitionInputSchema.parse(input)),
    ),
    proposalTransitionResponseSchema,
  );
}
/**
 * Record an accept/decline decision, and — for an acceptance — create the session in the same
 * request.
 *
 * One call, because the two halves belong to two domains and sequencing them is the server's
 * job, not the client's: the recorded decision is what authorizes the session, and a client that
 * had to make the second call could leave a proposal accepted with nothing to show for it. The
 * response's `acceptances` says which half happened for every proposal; a `decision_only` entry
 * means the decision stands and re-posting it retries the session.
 */
export async function recordProposalDecision(
  eventId: string,
  input: z.input<typeof recordProposalDecisionInputSchema>,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/decisions`,
      json(recordProposalDecisionInputSchema.parse(input)),
    ),
    proposalDecisionResponseSchema,
  );
}
export async function getReviewerQueue(eventId: string): Promise<ReviewerQueueDto> {
  return decode(await fetch(`/api/events/${eventId}/review/assignments`), reviewerQueueSchema);
}
export async function declareReviewConflict(eventId: string, assignmentId: string, reason: string) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/assignments/${assignmentId}/conflict`,
      json({ reason }),
    ),
    reviewConflictResponseSchema,
  );
}
export async function saveReviewEvaluation(
  eventId: string,
  assignmentId: string,
  input: SaveEvaluationInput,
) {
  const response = await fetch(
    `/api/events/${eventId}/review/assignments/${assignmentId}/evaluation`,
    { ...json(saveEvaluationInputSchema.parse(input)), method: "PUT" },
  );
  return decode(response, evaluationResponseSchema);
}
/** Ask the assistant for a draft. Throws `ReviewApiError` when it is unavailable. */
export async function requestReviewSuggestion(eventId: string, assignmentId: string) {
  return decode(
    await fetch(`/api/events/${eventId}/review/assignments/${assignmentId}/suggestions`, {
      method: "POST",
    }),
    reviewSuggestionResponseSchema,
  );
}
/**
 * Accept a suggestion into the reviewer's own draft, or dismiss it.
 *
 * `includeSummaryInNotes` is passed explicitly on every call rather than left to the schema
 * default, so the choice is visible at the call site — the point of the flag is that model prose
 * only reaches the reviewer's notes because they asked for it.
 */
export async function respondToReviewSuggestion(
  eventId: string,
  assignmentId: string,
  suggestionId: string,
  response: "accepted" | "rejected",
  includeSummaryInNotes = false,
) {
  return decode(
    await fetch(
      `/api/events/${eventId}/review/assignments/${assignmentId}/suggestions/${suggestionId}/response`,
      json(respondToSuggestionInputSchema.parse({ response, includeSummaryInNotes })),
    ),
    suggestionResponseResponseSchema,
  );
}
