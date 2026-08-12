import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  evaluationResponseSchema,
  type OrganizerReviewWorkspaceDto,
  organizerReviewWorkspaceSchema,
  proposalDecisionResponseSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  recordProposalDecisionInputSchema,
  type ReviewerQueueDto,
  reviewAssignmentRemovalResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewerQueueSchema,
  reviewPlanResponseSchema,
  type SaveEvaluationInput,
  saveEvaluationInputSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch } from "./config";

export class ReviewApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}
async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new ReviewApiError(parsed.data);
    throw new Error(`Review API failed with status ${response.status}`);
  }
  return schema.parse(body);
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
