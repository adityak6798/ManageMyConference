/**
 * The organizer's form composer and the public applicant surface, including the throttle that keeps one address from flooding submissions.
 *
 * Owned by the `cfp` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-CFP-001 PRD-CFP-002 PRD-ABS-001
 */
import {
  cfpProposalParamsSchema,
  cfpStateInputSchema,
  cfpRoutingStatusesResponseSchema,
  cfpWindowInputSchema,
  createProposalDraftInputSchema,
  eventIdParamsSchema,
  saveCfpInputSchema,
  saveProposalInputSchema,
  submitProposalInputSchema,
} from "@greenroom/contracts";
import {
  CfpClosedError,
  CfpRoutingConfigurationError,
  CfpDraftConflictError,
  CfpProposalNotFoundError,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "../../../application/cfp/public";
import { clientAddress, submissionThrottle } from "../throttle";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/cfp",
  "GET /api/events/:eventId/cfp/routing-statuses",
  "PUT /api/events/:eventId/cfp",
  "PUT /api/events/:eventId/cfp/window",
  "POST /api/events/:eventId/cfp/state",
  /*
   * The submitter's own proposals.
   *
   * Under `/api/events/...` and deliberately not under `/api/public/...`, which is anonymous by
   * construction: that namespace answers `Access-Control-Allow-Origin: *` and is cacheable with a
   * validator, and neither may be true of one person's drafts. Authorization here is a session plus
   * ownership of the row rather than an event capability — a person proposing a talk holds no role
   * on the conference, which is the whole point of a public call. See `CfpService`'s `submitterFor`.
   */
  "GET /api/events/:eventId/cfp/proposals",
  "POST /api/events/:eventId/cfp/proposals",
  "GET /api/events/:eventId/cfp/proposals/:proposalId",
  "PUT /api/events/:eventId/cfp/proposals/:proposalId",
  "POST /api/events/:eventId/cfp/proposals/:proposalId/submit",
  "GET /api/public/events/:eventId/cfp",
  "POST /api/public/events/:eventId/submissions",
] as const;

export const cfpRoutes: RouteModule = {
  domain: "cfp",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { cfp: cfpService, auth } = dependencies;
    app.get("/api/events/:eventId/cfp", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const cfp = await cfpService.getForOrganizer(context.get("actor"), parsed.data.eventId);
      if (!cfp)
        return context.json(
          envelope("NOT_FOUND", "No CFP has been configured.", context.get("correlationId")),
          404,
        );
      return context.json({ cfp });
    });
    app.get("/api/events/:eventId/cfp/routing-statuses", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const statuses = await cfpService.routingStatuses(context.get("actor"), parsed.data.eventId);
      return context.json(cfpRoutingStatusesResponseSchema.parse({ statuses }));
    });
    app.put("/api/events/:eventId/cfp", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorization happens before parsing attacker-controlled bodies.
      await cfpService.getForOrganizer(context.get("actor"), params.data.eventId);
      const parsed = saveCfpInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The CFP could not be saved.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        cfp: await cfpService.save(context.get("actor"), {
          eventId: params.data.eventId,
          ...parsed.data,
        }),
      });
    });
    app.put("/api/events/:eventId/cfp/window", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorization before an attacker-controlled body is parsed, as on every write here.
      await cfpService.getForOrganizer(context.get("actor"), params.data.eventId);
      const parsed = cfpWindowInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The submission window could not be saved.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        cfp: await cfpService.saveWindow(context.get("actor"), params.data.eventId, parsed.data),
      });
    });
    /*
     * The submitter's dashboard and the three writes behind it.
     *
     * Each hands `context.get("actor")` to the service and nothing else about identity: the owner
     * of a proposal is the resolved session, never a field of the request. That is what makes the
     * confirmation these writes queue safe to send — see `docs/architecture/data-flows.md` and the
     * note on `#132` in `CfpNotificationPort`.
     */
    app.get("/api/events/:eventId/cfp/proposals", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({
        proposals: await cfpService.myProposals(context.get("actor"), params.data.eventId),
      });
    });
    app.post("/api/events/:eventId/cfp/proposals", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = createProposalDraftInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The draft could not be saved.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json(
        {
          proposal: await cfpService.createDraft(
            context.get("actor"),
            params.data.eventId,
            parsed.data.idempotencyKey,
            parsed.data.answers,
          ),
        },
        201,
      );
    });
    app.get("/api/events/:eventId/cfp/proposals/:proposalId", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = cfpProposalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Proposal ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({
        proposal: await cfpService.myProposal(
          context.get("actor"),
          params.data.eventId,
          params.data.proposalId,
        ),
      });
    });
    app.put("/api/events/:eventId/cfp/proposals/:proposalId", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = cfpProposalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Proposal ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = saveProposalInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The proposal could not be saved.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        proposal: await cfpService.saveProposal(
          context.get("actor"),
          params.data.eventId,
          params.data.proposalId,
          parsed.data.answers,
          parsed.data.expectedRevision,
        ),
      });
    });
    app.post("/api/events/:eventId/cfp/proposals/:proposalId/submit", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = cfpProposalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Proposal ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = saveProposalInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The proposal could not be submitted.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        proposal: await cfpService.submitProposal(
          context.get("actor"),
          params.data.eventId,
          params.data.proposalId,
          parsed.data.answers,
          parsed.data.expectedRevision,
        ),
      });
    });
    app.post("/api/events/:eventId/cfp/state", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      await cfpService.getForOrganizer(context.get("actor"), params.data.eventId);
      const parsed = cfpStateInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Choose a valid CFP state.", context.get("correlationId")),
          400,
        );
      return context.json({
        cfp: await cfpService.changeState(
          context.get("actor"),
          params.data.eventId,
          parsed.data.state,
        ),
      });
    });
    app.get("/api/public/events/:eventId/cfp", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({ cfp: await cfpService.getPublished(parsed.data.eventId) });
    });
    app.post("/api/public/events/:eventId/submissions", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      /*
       * The only write in the API that needs no session, so it is the only one an anonymous
       * flood can reach. Checked before the body is parsed, so a refused caller costs nothing
       * but a map lookup. Best effort by design — see `throttle.ts`.
       *
       * The key is the address ALONE, deliberately. Adding `:${eventId}` reads as tighter — one
       * submitter cannot spend another event's budget — but the event id comes from the path and
       * is never checked for existence, so it let one client mint unlimited distinct keys. With a
       * bounded key table that is self-eviction: spend the budget on the real event, rotate 10,000
       * junk ids, and the exhausted counter is gone. Reproduced against the shipped parameters.
       * One address therefore owns exactly one window, and rotating ids creates no keys at all.
       */
      const throttled = submissionThrottle.check(
        clientAddress(context.req.raw.headers),
        (auth.now ?? Date.now)(),
      );
      if (!throttled.allowed) {
        context.header("retry-after", String(throttled.retryAfterSeconds));
        return context.json(
          envelope(
            "RATE_LIMITED",
            "Too many proposals from this address. Try again shortly.",
            context.get("correlationId"),
          ),
          429,
        );
      }
      const parsed = submitProposalInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The proposal could not be submitted.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      const submission = await cfpService.submit(
        params.data.eventId,
        parsed.data.idempotencyKey,
        parsed.data.answers,
      );
      return context.json(
        { submission: { confirmationId: submission.id, submittedAt: submission.submittedAt } },
        201,
      );
    });
  },
  translateError(error: unknown) {
    if (error instanceof CfpValidationError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "Review the highlighted proposal fields.",
        status: 400 as const,
        fields: error.fieldErrors,
      };
    if (error instanceof CfpRoutingConfigurationError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CfpDraftConflictError)
      return {
        code: "CONFLICT" as const,
        message: "This draft changed elsewhere. Reload the latest draft before saving again.",
        status: 409 as const,
      };
    /*
     * A closed call is a 409, not a 404 or a 400.
     *
     * The request is well formed and the resource exists; what refuses it is the state the
     * resource is in, which is exactly what `CONFLICT` means and what a client needs to know to
     * show "the deadline passed" rather than "something is wrong with your form". The message
     * carries which of the three closures it was, because "not open yet" and "you have missed it"
     * are opposite things to tell somebody.
     */
    if (error instanceof CfpClosedError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    // Indistinguishable from a proposal that does not exist, deliberately: see
    // `CfpProposalNotFoundError`.
    if (error instanceof CfpProposalNotFoundError)
      return { code: "NOT_FOUND" as const, message: "Proposal not found.", status: 404 as const };
    if (error instanceof CfpStateError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CfpUnavailableError)
      return { code: "NOT_FOUND" as const, message: error.message, status: 404 as const };
    return null;
  },
};
