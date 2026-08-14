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
  submitterProposalResponseSchema,
  submitterProposalsResponseSchema,
} from "@greenroom/contracts";
import {
  CfpClosedError,
  CfpRoutingConfigurationError,
  CfpDraftConflictError,
  CfpProposalStateConflictError,
  CfpProposalNotFoundError,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
  submitterFor,
} from "../../../application/cfp/public";
import { clientAddress, submissionThrottle } from "../throttle";
import { envelope, type HttpContext, validationFields, readJson } from "../runtime";
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

    /**
     * These routes are authorized by ownership rather than by an event capability, which makes them
     * the only event-addressed routes that never call `requireEventCapability` — and that makes
     * every *other* credential grammar a problem rather than a nicety.
     *
     * An event-scoped bearer token is documented as "restricted to one event they can read"
     * (`ARC-AUTH-001`), and `resolveEventToken` enforces that by narrowing `eventAccess` — which
     * these routes do not read, so a token minted for one event would work against every other. An
     * API-client credential is worse: it satisfies "is there an actor" with no scopes at all, and
     * its `id` is a client row rather than a user, so it reaches `submitter_user_id REFERENCES
     * users(id)` and dies as an opaque 500.
     *
     * Both are refused here rather than in the service, because the distinction is about *how the
     * caller authenticated* and the transport is the only layer that knows. Proposing a talk is a
     * person's act; a machine identity has no business owning one.
     *
     * **Middleware on the prefix rather than a line in each handler.** A repeated guard is one a
     * sixth route added later silently does not get, and nothing would fail to say so — which is
     * what a review pass pointed out about the first version of this. Hono applies `use` to
     * handlers registered after it, and the five routes below are the only ones under this prefix.
     */
    const refuseMachineCredentials = async (context: HttpContext, next: () => Promise<void>) => {
      if (context.get("authentication") !== "bearer") return next();
      return context.json(
        envelope(
          "FORBIDDEN",
          "Proposals belong to a person's account. Sign in rather than using an API credential or an event token.",
          context.get("correlationId"),
        ),
        403,
      );
    };
    /*
     * One mount, not two. Hono's `/*` matches zero trailing segments, so this covers the
     * collection path as well — a review pass proved it by deleting the separate collection mount
     * and watching all eight tests stay green, which is also what showed that the second mount was
     * carrying no assertion of its own.
     *
     * It stays in `register` rather than `registerRequestScope`: the contract in `contract.ts`
     * reserves that hook for middleware that must precede *other* domains' handlers, and this is
     * scoped to this module's own prefix.
     */
    app.use("/api/events/:eventId/cfp/proposals/*", refuseMachineCredentials);

    app.get("/api/events/:eventId/cfp/proposals", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      /*
       * `private, no-store` on one person's proposals, which the shared `/api/public/*` policy does
       * not cover because these deliberately live outside that namespace. This page is reached from
       * a public link and its own sign-out control reasons about a shared or borrowed machine, so
       * leaving a drafts payload in a browser or proxy cache is the one storage decision worth
       * making explicitly. `routes/content.ts` sets the same header for the same reason.
       */
      context.header("cache-control", "private, no-store");
      return context.json(
        submitterProposalsResponseSchema.parse({
          proposals: await cfpService.myProposals(context.get("actor"), params.data.eventId),
        }),
      );
    });
    app.post("/api/events/:eventId/cfp/proposals", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorization before an attacker-controlled body is parsed, as on every write here.
      // `submitterFor` establishes only that there is an account; ownership of the row is
      // asserted inside the write itself, and the service runs this again rather than
      // trusting that the transport did.
      submitterFor(context.get("actor"));
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
        submitterProposalResponseSchema.parse({
          proposal: await cfpService.createDraft(
            context.get("actor"),
            params.data.eventId,
            parsed.data.idempotencyKey,
            parsed.data.answers,
          ),
        }),
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
      context.header("cache-control", "private, no-store");
      return context.json(
        submitterProposalResponseSchema.parse({
          proposal: await cfpService.myProposal(
            context.get("actor"),
            params.data.eventId,
            params.data.proposalId,
          ),
        }),
      );
    });
    app.put("/api/events/:eventId/cfp/proposals/:proposalId", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = cfpProposalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Proposal ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorization before an attacker-controlled body is parsed, as on every write here.
      // `submitterFor` establishes only that there is an account; ownership of the row is
      // asserted inside the write itself, and the service runs this again rather than
      // trusting that the transport did.
      submitterFor(context.get("actor"));
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
      return context.json(
        submitterProposalResponseSchema.parse({
          proposal: await cfpService.saveProposal(
            context.get("actor"),
            params.data.eventId,
            params.data.proposalId,
            parsed.data.answers,
            parsed.data.expectedRevision,
          ),
        }),
      );
    });
    app.post("/api/events/:eventId/cfp/proposals/:proposalId/submit", async (context) => {
      if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
      const params = cfpProposalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Proposal ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorization before an attacker-controlled body is parsed, as on every write here.
      // `submitterFor` establishes only that there is an account; ownership of the row is
      // asserted inside the write itself, and the service runs this again rather than
      // trusting that the transport did.
      submitterFor(context.get("actor"));
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
      return context.json(
        submitterProposalResponseSchema.parse({
          proposal: await cfpService.submitProposal(
            context.get("actor"),
            params.data.eventId,
            params.data.proposalId,
            parsed.data.answers,
            parsed.data.expectedRevision,
          ),
        }),
      );
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
        // The service's own wording, not a fixed sentence. This route now serves *submitted*
        // proposals as well as drafts, and the hard-coded line told an applicant who lost a
        // revision race on a submitted proposal to "reload the latest draft" — about something
        // that is not a draft. The service composes the sentence for the case it detected.
        message: error.message,
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
    // And a proposal that has moved on is the same kind of answer for the same reason: the
    // request is well formed and the resource exists, and what refuses it is the state it is in.
    // Its own error type exists so it cannot fall through to `CfpStateError`'s 400, which would
    // tell an applicant their answers were wrong about a proposal they had already submitted.
    if (error instanceof CfpProposalStateConflictError)
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
