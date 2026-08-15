/**
 * Assignment, scoring, conflict declaration, transitions and decisions.
 *
 * Owned by the `review` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  advanceReviewRoundInputSchema,
  advanceReviewRoundResponseSchema,
  assignReviewersInputSchema,
  createReviewRoundInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  declareConflictInputSchema,
  distributeReviewersInputSchema,
  evaluationResponseSchema,
  organizerReviewWorkspaceSchema,
  proposalDecisionResponseSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  recordProposalDecisionInputSchema,
  remindReviewersInputSchema,
  remindReviewersResponseSchema,
  reviewAssignmentParamsSchema,
  reviewAssignmentRemovalResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewEventParamsSchema,
  reviewOrganizerQuerySchema,
  reviewPlanResponseSchema,
  reviewRoundParamsSchema,
  reviewRoundResponseSchema,
  reviewRoundsResponseSchema,
  respondToSuggestionInputSchema,
  reviewSuggestionParamsSchema,
  reviewSuggestionResponseSchema,
  reviewerQueueSchema,
  saveEvaluationInputSchema,
  setReviewRoundPoolInputSchema,
  suggestionResponseResponseSchema,
  updateReviewRoundInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const reviewPaths: OpenApiFragment = {
  domain: "review",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/review/organizer",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: reviewEventParamsSchema, query: reviewOrganizerQuerySchema },
      responses: {
        200: {
          description: "Organizer triage, plan, assignments, audit, and outcomes",
          content: json(organizerReviewWorkspaceSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/review/plan",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(configureReviewPlanInputSchema) },
      },
      responses: {
        200: { description: "Saved evaluation plan", content: json(reviewPlanResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/review/round-plans",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: reviewEventParamsSchema },
      responses: {
        200: {
          description: "Every configured review round with its reviewer pool",
          content: json(reviewRoundsResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/round-plans",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(createReviewRoundInputSchema) },
      },
      responses: {
        201: {
          description: "The created round; its sequence is allocated by the server",
          content: json(reviewRoundResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/review/round-plans/{sequence}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewRoundParamsSchema,
        body: { required: true, content: json(updateReviewRoundInputSchema) },
      },
      responses: {
        200: { description: "The updated round", content: json(reviewRoundResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/review/round-plans/{sequence}/pool",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewRoundParamsSchema,
        body: { required: true, content: json(setReviewRoundPoolInputSchema) },
      },
      responses: {
        200: {
          description: "The round with its new pool",
          content: json(reviewRoundResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/reminders",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(remindReviewersInputSchema) },
      },
      responses: {
        200: {
          description:
            "What became of each reviewer's reminder: queued, already sent, unaddressable, or nothing outstanding",
          content: json(remindReviewersResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/review/statuses",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(configureProposalStatusesInputSchema) },
      },
      responses: {
        200: {
          description: "Saved event proposal statuses",
          content: json(proposalStatusesResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/assignments",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(assignReviewersInputSchema) },
      },
      responses: {
        201: {
          description: "Created reviewer assignments",
          content: json(reviewAssignmentsResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/assignments/distribute",
      description:
        "Deterministically balances proposals across reviewers up to a per-reviewer cap.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(distributeReviewersInputSchema) },
      },
      responses: {
        201: {
          description: "Distributed assignments",
          content: json(reviewAssignmentsResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/rounds",
      description:
        "Advances proposals in one status into the next review round without replacing prior work.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(advanceReviewRoundInputSchema) },
      },
      responses: {
        201: {
          description: "Created next-round assignments",
          content: json(advanceReviewRoundResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/transitions",
      description:
        "Atomically transitions every named proposal or applies none. The reserved decision statuses are refused here: reaching `accepted`/`declined` is the effect of a recorded decision, so `POST /api/events/{eventId}/review/decisions` is what records one.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(bulkProposalTransitionInputSchema) },
      },
      responses: {
        200: {
          description: "Atomic proposal transition",
          content: json(proposalTransitionResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/decisions",
      description:
        "Records an accept/decline decision and moves the proposal to the matching reserved status. For an accepted outcome the same request also creates the session, because the recorded decision is what authorizes it; `acceptances` reports which half happened per proposal. A `decision_only` entry means the decision is durable and the session was refused, so re-posting the identical decision retries it.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewEventParamsSchema,
        body: { required: true, content: json(recordProposalDecisionInputSchema) },
      },
      responses: {
        201: {
          description: "Recorded acceptance decisions",
          content: json(proposalDecisionResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/review/assignments",
      description: "Reviewer-owned assignment queue; aggregate outcomes are intentionally absent.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: reviewEventParamsSchema },
      responses: {
        200: { description: "Assigned reviewer queue", content: json(reviewerQueueSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/events/{eventId}/review/assignments/{assignmentId}",
      description:
        "Removes a review assignment, together with any draft evaluation or declared conflict hanging off it. This is how a mis-assignment is corrected and how the evaluation rubric — locked while any assignment exists — is unlocked again. Refused with 400 once that reviewer has completed their evaluation, because the score is already counted in the abstract's aggregate.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: reviewAssignmentParamsSchema },
      responses: {
        200: {
          description: "Removed reviewer assignment",
          content: json(reviewAssignmentRemovalResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/assignments/{assignmentId}/conflict",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewAssignmentParamsSchema,
        body: { required: true, content: json(declareConflictInputSchema) },
      },
      responses: {
        200: {
          description: "Declared assignment conflict",
          content: json(reviewConflictResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/review/assignments/{assignmentId}/evaluation",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewAssignmentParamsSchema,
        body: { required: true, content: json(saveEvaluationInputSchema) },
      },
      responses: {
        200: {
          description: "Saved draft or completed evaluation",
          content: json(evaluationResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/assignments/{assignmentId}/suggestions",
      description:
        "Drafts an AI suggestion for this assignment: a summary and one value per rubric criterion, each with a rationale, stored with the model, prompt version, time and abstract revision it came from. The suggestion is a draft and nothing else — it is not an evaluation, it is counted in no aggregate, and it becomes part of the reviewer's record only through the response route below. The proposal crosses the provider boundary with its submitter masked, exactly as the reviewer sees it. 404 when the deployment has no assistant configured; 502 when the provider was slow, throttled or unusable, in which case the reviewer scores by hand and may try again.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: reviewAssignmentParamsSchema },
      responses: {
        201: {
          description: "Drafted suggestion, with its provenance",
          content: json(reviewSuggestionResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        502: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/review/assignments/{assignmentId}/suggestions/{suggestionId}/response",
      description:
        "Records the reviewer's answer to a suggestion. Accepting writes their own evaluation as a **draft** carrying `source: \"suggested\"` and the suggestion's id — completing it remains a separate reviewer action, and only that action moves an aggregate. Rejecting writes no evaluation at all and leaves only the suggestion row, marked rejected with the reviewer's name, as the audit record. Refused with 400 when the drafted values do not satisfy the rubric, naming the criteria the reviewer must score themselves, and with 409 once the suggestion has already been answered.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: reviewSuggestionParamsSchema,
        body: { required: true, content: json(respondToSuggestionInputSchema) },
      },
      responses: {
        200: {
          description: "The answered suggestion, and the reviewer's draft when they accepted",
          content: json(suggestionResponseResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
  },
};
