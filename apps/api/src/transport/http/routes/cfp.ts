/**
 * The organizer's form composer and the public applicant surface, including the throttle that keeps one address from flooding submissions.
 *
 * Owned by the `cfp` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-CFP-001 PRD-CFP-002 PRD-ABS-001
 */
import {
  cfpStateInputSchema,
  cfpRoutingStatusesResponseSchema,
  eventIdParamsSchema,
  saveCfpInputSchema,
  submitProposalInputSchema,
} from "@greenroom/contracts";
import {
  CfpRoutingConfigurationError,
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
  "POST /api/events/:eventId/cfp/state",
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
    if (error instanceof CfpStateError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CfpUnavailableError)
      return { code: "NOT_FOUND" as const, message: error.message, status: 404 as const };
    return null;
  },
};
