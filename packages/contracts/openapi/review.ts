/**
 * Assignment, scoring, conflict declaration, transitions and decisions.
 *
 * Owned by the `review` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  declareConflictInputSchema,
  evaluationResponseSchema,
  organizerReviewWorkspaceSchema,
  proposalDecisionResponseSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  recordProposalDecisionInputSchema,
  reviewAssignmentParamsSchema,
  reviewAssignmentRemovalResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewEventParamsSchema,
  reviewOrganizerQuerySchema,
  reviewPlanResponseSchema,
  reviewerQueueSchema,
  saveEvaluationInputSchema,
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
  },
};
