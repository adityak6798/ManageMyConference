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
  createReviewRoundInputSchema,
  declareConflictInputSchema,
  distributeReviewersInputSchema,
  type ProposalAcceptanceDto,
  proposalStatusSchema,
  recordProposalDecisionInputSchema,
  recomputeReviewRoundInputSchema,
  inviteReviewRoundInputSchema,
  remindReviewersInputSchema,
  respondToSuggestionInputSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  reviewRoundParamsSchema,
  reviewSuggestionParamsSchema,
  saveEvaluationInputSchema,
  setReviewRoundPoolInputSchema,
  updateReviewRoundInputSchema,
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
  SuggestionsDisabledError,
} from "../../../application/review/review-service";
import { SuggestionUnavailableError } from "../../../application/review/suggestion-port";
import { envelope, readJson, validationFields } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/review/organizer",
  "PUT /api/events/:eventId/review/plan",
  "PUT /api/events/:eventId/review/statuses",
  "POST /api/events/:eventId/review/assignments",
  "POST /api/events/:eventId/review/assignments/distribute",
  "POST /api/events/:eventId/review/rounds",
  /*
   * The round as a configured resource, addressed under `round-plans` rather than `rounds`.
   *
   * Two names for one concept is a smell, so it is worth stating why this is the lesser of the
   * available evils. `POST /review/rounds` already exists and means *advance the abstracts in a
   * status into the next round* — an action, not a creation — and it is what the console and the
   * browser suite call. Repurposing it would silently change what an in-flight client does;
   * moving it would break one. `/review/plan` is taken too, by the event's rubric, so `plans`
   * would sit one character away from a different resource in every log line and every path list.
   *
   * `round-plans` is the issue's own vocabulary ("first-class review plans and rounds") and
   * collides with neither. `sequence` is the round's number — the same integer every assignment,
   * outcome and suggestion of that round carries — and is allocated by the server, so it appears
   * in the path but never in a creation body.
   */
  "GET /api/events/:eventId/review/round-plans",
  "POST /api/events/:eventId/review/round-plans",
  "PUT /api/events/:eventId/review/round-plans/:sequence",
  "PUT /api/events/:eventId/review/round-plans/:sequence/pool",
  "POST /api/events/:eventId/review/round-plans/:sequence/recompute",
  "POST /api/events/:eventId/review/round-plans/:sequence/invitations",
  "POST /api/events/:eventId/review/reminders",
  "DELETE /api/events/:eventId/review/assignments/:assignmentId",
  "POST /api/events/:eventId/review/transitions",
  "POST /api/events/:eventId/review/decisions",
  "GET /api/events/:eventId/review/assignments",
  "POST /api/events/:eventId/review/assignments/:assignmentId/conflict",
  "PUT /api/events/:eventId/review/assignments/:assignmentId/evaluation",
  "POST /api/events/:eventId/review/assignments/:assignmentId/suggestions",
  "POST /api/events/:eventId/review/assignments/:assignmentId/suggestions/:suggestionId/response",
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
            parsed.data.round,
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
    app.get("/api/events/:eventId/review/round-plans", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        rounds: await reviewService.listRounds(context.get("actor"), params.data.eventId),
      });
    });
    app.post("/api/events/:eventId/review/round-plans", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = createReviewRoundInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The review round is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json(
        {
          round: await reviewService.createRound(
            context.get("actor"),
            params.data.eventId,
            parsed.data,
          ),
        },
        201,
      );
    });
    app.put("/api/events/:eventId/review/round-plans/:sequence", async (context) => {
      const params = reviewRoundParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Round path is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = updateReviewRoundInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The review round is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        round: await reviewService.updateRound(
          context.get("actor"),
          params.data.eventId,
          params.data.sequence,
          parsed.data,
        ),
      });
    });
    /**
     * Replace a round's reviewer pool.
     *
     * A `PUT` of the whole list rather than add/remove verbs, because the organizer's mental model
     * is "these are the reviewers of this round" and a pair of verbs makes two requests out of one
     * edit — with a window between them in which the pool is a state nobody chose. Refused for a
     * reviewer who already holds assignments in the round; the service says so in
     * `fieldErrors.reviewerIds`.
     */
    app.put("/api/events/:eventId/review/round-plans/:sequence/pool", async (context) => {
      const params = reviewRoundParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Round path is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = setReviewRoundPoolInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The reviewer pool is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        round: await reviewService.setRoundPool(
          context.get("actor"),
          params.data.eventId,
          params.data.sequence,
          parsed.data.reviewerIds,
        ),
      });
    });
    app.post("/api/events/:eventId/review/round-plans/:sequence/recompute", async (context) => {
      const params = reviewRoundParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Round path is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = recomputeReviewRoundInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The review filters are invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        round: await reviewService.recomputeRound(
          context.get("actor"),
          params.data.eventId,
          params.data.sequence,
          parsed.data.filters,
        ),
      });
    });
    app.post("/api/events/:eventId/review/round-plans/:sequence/invitations", async (context) => {
      const params = reviewRoundParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Review round is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = inviteReviewRoundInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Invitation mode is invalid.",
            context.get("correlationId"),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        invitations: await reviewService.inviteRoundReviewers(
          context.get("actor"),
          params.data.eventId,
          params.data.sequence,
          parsed.data.mode,
        ),
      });
    });
    /**
     * Remind selected reviewers that they still owe evaluations in a round.
     *
     * `200` rather than `201`: a reminder that had already been sent creates nothing, and this
     * route's whole job is to report which of those two happened for each reviewer. The response
     * is per reviewer for the same reason — a request naming four people where one has no linked
     * address must not be reported as four messages sent.
     */
    app.post("/api/events/:eventId/review/reminders", async (context) => {
      const params = reviewEventParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
      const parsed = remindReviewersInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The reminder request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!reviewService) throw new Error("Review service is not configured");
      return context.json({
        reminders: await reviewService.remindOutstandingReviewers(
          context.get("actor"),
          params.data.eventId,
          parsed.data.round,
          parsed.data.reviewerIds,
        ),
      });
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
            // `acceptSession` rather than `accept`: this route reads one field off the result,
            // and the difference between the two methods is a projection of the event's whole
            // content workspace that nothing here looks at (issue #207). Same authorization,
            // same write, same notifications.
            const sessionId = await contentService.acceptSession(
              context.get("actor"),
              { eventId, proposalId },
              context.get("correlationId"),
            );
            acceptances.push({
              proposalId,
              state: "content",
              sessionId,
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
        // A fact about the deployment rather than about any abstract, so the surface can withhold
        // the Draft control entirely where there is no assistant to draft with.
        suggestionsEnabled: reviewService.suggestionsEnabled,
      });
    });
    /**
     * Ask for an AI-drafted suggestion.
     *
     * `POST` because it creates a suggestion resource, and `201` for the same reason — a draft is
     * a thing that now exists and can be fetched with the queue, not a computed view. It is the
     * only route in this module whose failure is *expected* often enough to be a designed state
     * rather than an error: a provider that is slow, throttled or misconfigured produces a
     * `UPSTREAM_UNAVAILABLE` the reviewer's surface renders as a notice beside a scoring form that
     * still works.
     */
    app.post(
      "/api/events/:eventId/review/assignments/:assignmentId/suggestions",
      async (context) => {
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
        if (!reviewService) throw new Error("Review service is not configured");
        return context.json(
          {
            suggestion: await reviewService.requestSuggestion(
              context.get("actor"),
              params.data.eventId,
              params.data.assignmentId,
            ),
          },
          201,
        );
      },
    );
    /**
     * The reviewer's answer: accept the draft into their own record, or dismiss it.
     *
     * A separate route from the evaluation `PUT` on purpose. Accepting is not "saving scores that
     * happen to have come from somewhere" — it is the act the provenance record describes, and
     * giving it its own address is what lets storage refuse an evaluation that claims a
     * suggestion nobody accepted.
     */
    app.post(
      "/api/events/:eventId/review/assignments/:assignmentId/suggestions/:suggestionId/response",
      async (context) => {
        const params = reviewSuggestionParamsSchema.safeParse(context.req.param());
        if (!params.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Suggestion path is malformed.",
              context.get("correlationId"),
            ),
            400,
          );
        requireEventCapability(context.get("actor"), params.data.eventId, "review:evaluate");
        const parsed = respondToSuggestionInputSchema.safeParse(await readJson(context.req));
        if (!parsed.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Choose whether to accept or dismiss this suggestion.",
              context.get("correlationId"),
              validationFields(parsed.error.issues),
            ),
            400,
          );
        if (!reviewService) throw new Error("Review service is not configured");
        return context.json(
          await reviewService.respondToSuggestion(
            context.get("actor"),
            params.data.eventId,
            params.data.assignmentId,
            params.data.suggestionId,
            parsed.data.response,
            { includeSummaryInNotes: parsed.data.includeSummaryInNotes },
          ),
        );
      },
    );
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
    /*
     * A failed suggestion is not a failed request in the sense the reviewer cares about.
     *
     * `UPSTREAM_UNAVAILABLE` rather than `INTERNAL_ERROR` for the same reason the Accelevents sync
     * uses it: a model that timed out is neither our bug nor the reviewer's mistake, and telling
     * them "internal error" sends them looking in the wrong place. The message names the manual
     * path explicitly, because the whole failure design is that scoring by hand still works — and
     * the normalized code travels in `fieldErrors` so a surface can distinguish a timeout worth
     * pressing again from a refusal that is not, without ever carrying provider text.
     */
    if (error instanceof SuggestionUnavailableError)
      return {
        code: "UPSTREAM_UNAVAILABLE" as const,
        message:
          "The review assistant could not draft a suggestion. Score this abstract yourself, or try again.",
        status: 502 as const,
        fields: { suggestion: [error.code] },
      };
    if (error instanceof SuggestionsDisabledError)
      return {
        code: "NOT_FOUND" as const,
        message: "AI-assisted review is switched off for this deployment.",
        status: 404 as const,
      };
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
