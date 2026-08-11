import {
  apiErrorEnvelopeSchema,
  type ApiErrorEnvelope,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureReviewPlanInputSchema,
  configureProposalStatusesInputSchema,
  evaluationResponseSchema,
  organizerReviewWorkspaceSchema,
  type OrganizerReviewWorkspaceDto,
  proposalTransitionResponseSchema,
  proposalStatusesResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewPlanResponseSchema,
  reviewerQueueSchema,
  type ReviewerQueueDto,
  saveEvaluationInputSchema,
  type SaveEvaluationInput,
} from "@greenroom/contracts";
import type { z } from "zod";

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
