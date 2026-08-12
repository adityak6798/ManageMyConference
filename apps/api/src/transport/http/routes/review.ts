/**
 * Assignment, scoring, conflict declaration, bulk transitions and the accept/decline decision. The heaviest surface in the transport, and the one that most often collided with other domains in `app.ts`.
 *
 * Owned by the `review` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-REV-001
 */
import {
  advanceReviewRoundInputSchema,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  declareConflictInputSchema,
  distributeReviewersInputSchema,
  proposalStatusSchema,
  recordProposalDecisionInputSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  saveEvaluationInputSchema,
  type ProposalAcceptanceDto,
} from "@greenroom/contracts";
import { SpeakerIdentityUnavailableError } from "../../../application/content/content-service";
import { requireCapability, requireEventCapability } from "../../../application/identity/actor";
import {
  ProposalNotAcceptedError,
  ProposalNotFoundError,
  ProposalSubmitterUnavailableError,
} from "../../../application/review/public";
import {
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewValidationError,
} from "../../../application/review/review-service";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/review/organizer",
  "PUT /api/events/:eventId/review/plan",
  "PUT /api/events/:eventId/review/statuses",
  "POST /api/events/:eventId/review/assignments",
  "POST /api/events/:eventId/review/assignments/distribute",
  "POST /api/events/:eventId/review/rounds",
  "DELETE /api/events/:eventId/review/assignments/:assignmentId",
  "POST /api/events/:eventId/review/transitions",
  "POST /api/events/:eventId/review/decisions",
  "GET /api/events/:eventId/review/assignments",
  "POST /api/events/:eventId/review/assignments/:assignmentId/conflict",
  "PUT /api/events/:eventId/review/assignments/:assignmentId/evaluation",
] as const;

export const reviewRoutes: RouteModule = {
  domain: "review",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { review: reviewService, content, logger } = dependencies;
    app.get("/api/events/:eventId/review/organizer", async (context) => {
      const parsed = reviewEventParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const statusValue = context.req.query("status");
      const status = statusValue ? proposalStatusSchema.safeParse(statusValue) : undefined;
      if (status && !status.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Choose a valid proposal status.",
            context.get("correlationId"),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json(
        await reviewService.organizerWorkspace(
          context.get("actor"),
          parsed.data.eventId,
          status?.data,
        ),
      );
    });
    app.put("/api/events/:eventId/review/plan", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = configureReviewPlanInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The evaluation plan is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        plan: await reviewService.configurePlan(
          context.get("actor"),
          params.data.eventId,
          parsed.data.criteria,
        ),
      });
    });
    app.put("/api/events/:eventId/review/statuses", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = configureProposalStatusesInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The status configuration is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        statuses: await reviewService.configureStatuses(
          context.get("actor"),
          params.data.eventId,
          parsed.data.statuses,
        ),
      });
    });
    app.post("/api/events/:eventId/review/assignments", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = assignReviewersInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The assignment request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json(
        {
          assignments: await reviewService.assign(
            context.get("actor"),
            params.data.eventId,
            parsed.data.proposalIds,
            parsed.data.reviewerId,
          ),
        },
        201,
      );
    });
    app.post("/api/events/:eventId/review/assignments/distribute", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = distributeReviewersInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The distribution request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json(
        {
          assignments: await reviewService.distribute(
            context.get("actor"),
            params.data.eventId,
            parsed.data.proposalIds,
            parsed.data.reviewerIds,
            parsed.data.maxAssignmentsPerReviewer,
            parsed.data.round,
          ),
        },
        201,
      );
    });
    app.post("/api/events/:eventId/review/rounds", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = advanceReviewRoundInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The round request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json(
        await reviewService.advanceRound(
          context.get("actor"),
          params.data.eventId,
          parsed.data.fromStatus,
          parsed.data.reviewerIds,
          parsed.data.maxAssignmentsPerReviewer,
          parsed.data.currentRound,
        ),
        201,
      );
    });
    /**
     * Remove one review assignment.
     *
     * The organizer-side undo for a mis-assignment, and the only way the evaluation rubric stops
     * being locked by one. `DELETE` on the assignment itself rather than a verb under it, because
     * what the organizer is doing is removing the resource `POST /review/assignments` created.
     * Refused once the reviewer has completed their evaluation; the service says why in
     * `fieldErrors.assignmentId`.
     */
    app.delete("/api/events/:eventId/review/assignments/:assignmentId", async (context) => {
      const params = reviewAssignmentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Assignment path is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        assignment: await reviewService.unassign(
          context.get("actor"),
          params.data.eventId,
          params.data.assignmentId,
        ),
      });
    });
    app.post("/api/events/:eventId/review/transitions", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = bulkProposalTransitionInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The transition request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        proposals: await reviewService.bulkTransition(
          context.get("actor"),
          params.data.eventId,
          parsed.data.proposalIds,
          parsed.data.toStatus,
        ),
        mode: "atomic" as const,
      });
    });
    /**
     * A content refusal the organizer can act on.
     *
     * The decisions are already durable by the time acceptance runs, so a failure here can never
     * be reported as "the request failed" — that would deny state the server is holding. Every
     * error therefore becomes a per-proposal `decision_only` row. Typed content refusals get copy
     * the organizer can act on; anything else gets the correlation id and is logged at error level,
     * so an infrastructure fault is still diagnosable rather than dressed up as a validation
     * problem. `null` marks the unexpected case for the caller.
     */
    const acceptanceRefusal = (error: unknown) => {
      if (error instanceof ProposalSubmitterUnavailableError)
        return {
          detail: "This proposal has no contact address, so no speaker could be created from it.",
          fieldErrors: {
            "submitter.email": [
              "The published form collected no email address, so no speaker can be created.",
            ],
          },
        };
      if (error instanceof SpeakerIdentityUnavailableError)
        return {
          detail: "The speaker identity could not be created from this proposal.",
          fieldErrors: error.fields,
        };
      if (error instanceof ProposalNotAcceptedError || error instanceof ProposalNotFoundError)
        return {
          detail: "The content domain no longer sees an acceptance decision for this proposal.",
          fieldErrors: { proposalId: ["This proposal is not accepted."] },
        };
      return null;
    };
    app.post("/api/events/:eventId/review/decisions", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = recordProposalDecisionInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The decision request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      const { eventId } = params.data;
      // Acceptance is one request. Transport composes the two application services — the review
      // decision authorizes the session, and content creates it — so the client never orchestrates
      // across a domain boundary. Neither service imports the other: content depends on review's
      // public `AcceptedProposalQuery`, and review stays unaware of content.
      const contentService = parsed.data.outcome === "accepted" ? content : undefined;
      if (parsed.data.outcome === "accepted") {
        if (!contentService) throw new Error("Content service is unavailable");
        // Checked before anything is recorded: an actor who could not create the session must not
        // leave a decision behind.
        requireCapability(context.get("actor"), "content:manage");
      }
      const decided = await reviewService.decide(
        context.get("actor"),
        eventId,
        parsed.data.proposalIds,
        parsed.data.outcome,
        parsed.data.note,
      );
      const acceptances: ProposalAcceptanceDto[] = [];
      if (contentService)
        for (const { proposalId } of decided.decisions) {
          try {
            const workspace = await contentService.accept(
              context.get("actor"),
              { eventId, proposalId },
              context.get("correlationId"),
            );
            acceptances.push({
              proposalId,
              state: "content",
              sessionId:
                workspace.sessions.find((session) => session.proposalId === proposalId)?.id ?? null,
              detail: "",
              fieldErrors: {},
            });
          } catch (error) {
            const correlationId = context.get("correlationId");
            const refusal = acceptanceRefusal(error) ?? {
              detail: `The session could not be created. Reference: ${correlationId}`,
              fieldErrors: {},
            };
            // The decision is already durable and is not what failed, so it is reported as
            // recorded with the session missing rather than the whole request as refused.
            // Re-posting the identical decision overwrites it and retries the session, which
            // heals the gap. Answering 500 here would deny state the server is holding.
            const fields = {
              correlationId,
              operation: context.get("operation"),
              actorId: context.get("actor")?.id,
              eventId,
              proposalId,
              errorName: error instanceof Error ? error.name : "unknown",
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            // An unexpected fault is still a fault: it is logged at error level so it reaches the
            // same place a 500 would have, even though the response is a truthful 201.
            if (acceptanceRefusal(error)) logger.warn(fields, "review.acceptance.incomplete");
            else logger.error(fields, "review.acceptance.failed");
            acceptances.push({ proposalId, state: "decision_only", sessionId: null, ...refusal });
          }
        }
      return context.json({ ...decided, acceptances }, 201);
    });
    app.get("/api/events/:eventId/review/assignments", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        assignments: await reviewService.reviewerQueue(context.get("actor"), params.data.eventId),
      });
    });
    app.post("/api/events/:eventId/review/assignments/:assignmentId/conflict", async (context) => {
      const params = reviewAssignmentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Assignment path is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:evaluate");
      const parsed = declareConflictInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Describe the conflict.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        conflict: await reviewService.declareConflict(
          context.get("actor"),
          params.data.eventId,
          params.data.assignmentId,
          parsed.data.reason,
        ),
      });
    });
    app.put("/api/events/:eventId/review/assignments/:assignmentId/evaluation", async (context) => {
      const params = reviewAssignmentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Assignment path is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:evaluate");
      const parsed = saveEvaluationInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The evaluation is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        evaluation: await reviewService.saveEvaluation(
          context.get("actor"),
          params.data.eventId,
          params.data.assignmentId,
          parsed.data,
          context.get("correlationId"),
        ),
      });
    });
  },
  translateError(error: unknown) {
    if (error instanceof ReviewValidationError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "The review request is invalid.",
        status: 400 as const,
        fields: error.fields,
      };
    if (error instanceof ReviewConflictError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "Resolve the declared conflict before evaluating.",
        status: 409 as const,
      };
    if (error instanceof ReviewNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof ProposalNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof ProposalNotAcceptedError)
      return {
        code: "CONFLICT" as const,
        message: "Accept this proposal in review before scheduling it.",
        status: 409 as const,
        fields: { proposalId: ["This proposal has no recorded acceptance decision."] },
      };
    if (error instanceof ProposalSubmitterUnavailableError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "This proposal has no contact address.",
        status: 400 as const,
        fields: {
          "submitter.email": [
            "The published form collected no email address, so no speaker can be created.",
          ],
        },
      };
    return null;
  },
};
