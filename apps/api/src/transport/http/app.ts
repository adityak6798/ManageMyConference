import {
  type ApiErrorEnvelope,
  createEventInputSchema,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureReviewPlanInputSchema,
  declareConflictInputSchema,
  demoSessionInputSchema,
  eventIdParamsSchema,
  proposalStatusSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  saveEvaluationInputSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { EventService } from "../../application/events/event-service";
import {
  ReviewConflictError,
  ReviewNotFoundError,
  type ReviewService,
  ReviewValidationError,
} from "../../application/review/review-service";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireCapability,
} from "../../application/identity/actor";
import { createDemoSession, resolveDemoSession } from "../../application/identity/demo-session";
import { createEventInputToCommand, eventToDto } from "./event-mappers";

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
type Variables = { correlationId: string; actor: Actor | null; operation: string };
type ActorResolver = (
  persona: "organizer" | "reviewer" | "speaker" | "public",
) => Promise<Actor | null>;
export type RuntimeAuthConfig =
  | { demoMode: true; sessionSecret: string; now?: () => number; resolveActor: ActorResolver }
  | { demoMode: false; now?: () => number };
class MalformedJsonError extends Error {}
const correlationPattern = /^[A-Za-z0-9_-]{8,64}$/;

const envelope = (
  code: ApiErrorEnvelope["error"]["code"],
  message: string,
  correlationId: string,
  fieldErrors?: Record<string, string[]>,
): ApiErrorEnvelope => ({
  error: { code, message, correlationId, ...(fieldErrors ? { fieldErrors } : {}) },
});
const validationFields = (issues: { path: PropertyKey[]; message: string }[]) => {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "request";
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  return fields;
};
async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MalformedJsonError("Request body is not valid JSON");
  }
}

// @spec PRD-IAM-001 PRD-IAM-002 PRD-EVT-001
export function createHttpApp(
  service: EventService,
  logger: StructuredLogger,
  auth: RuntimeAuthConfig,
  reviewService?: ReviewService,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-correlation-id");
    const correlationId =
      supplied && correlationPattern.test(supplied) ? supplied : crypto.randomUUID();
    context.set("correlationId", correlationId);
    context.set(
      "actor",
      auth.demoMode
        ? await resolveDemoSession(
            getCookie(context, "greenroom_session"),
            auth.sessionSecret,
            (auth.now ?? Date.now)(),
            auth.resolveActor,
          )
        : null,
    );
    context.set("operation", `${context.req.method} ${context.req.path}`);
    context.header("x-correlation-id", correlationId);
    const startedAt = Date.now();
    await next();
    const fields = {
      correlationId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Date.now() - startedAt,
      actorId: context.get("actor")?.id,
      operation: context.get("operation"),
    };
    if (context.res.status === 401 || context.res.status === 403)
      logger.warn(fields, "request.denied");
    else if (context.res.status < 500) logger.info(fields, "request.completed");
  });

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      checks: { database: "configured", sessionSigning: auth.demoMode ? "configured" : "disabled" },
      providerMode: "deterministic-fakes",
      logFormat: "structured-json",
    }),
  );
  app.post("/api/demo-session", async (context) => {
    if (!auth.demoMode)
      return context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    const parsed = demoSessionInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Choose a valid demo persona.", context.get("correlationId")),
        400,
      );
    const sessionSecret = auth.sessionSecret;
    const now = (auth.now ?? Date.now)();
    setCookie(
      context,
      "greenroom_session",
      await createDemoSession(parsed.data.persona, sessionSecret, now + 28_800_000),
      {
        httpOnly: true,
        sameSite: "Strict",
        secure: new URL(context.req.url).protocol === "https:",
        path: "/",
        maxAge: 28_800,
      },
    );
    return context.json({ persona: parsed.data.persona });
  });
  app.get("/api/session", (context) => {
    const actor = context.get("actor");
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    return context.json({
      actor: { id: actor.id, name: actor.name, persona: actor.persona },
      organizations: actor.organizations,
      eventAccess: actor.eventAccess.map((access) => ({
        eventId: access.eventId,
        role: access.role,
        capabilities: [...access.capabilities],
      })),
      capabilities: [...actor.capabilities],
    });
  });
  app.get("/api/events", async (context) =>
    context.json({ events: (await service.list(context.get("actor"))).map(eventToDto) }),
  );
  app.post("/api/events", async (context) => {
    requireCapability(context.get("actor"), "events:create");
    const parsed = createEventInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The event could not be created.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    return context.json(
      {
        event: eventToDto(
          await service.create(context.get("actor"), createEventInputToCommand(parsed.data)),
        ),
      },
      201,
    );
  });
  app.get("/api/events/:eventId", async (context) => {
    requireCapability(context.get("actor"), "events:read");
    const parsed = eventIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    const event = await service.get(context.get("actor"), parsed.data.eventId);
    if (!event)
      return context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    return context.json({ event: eventToDto(event) });
  });
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
  app.post("/api/events/:eventId/review/assignments", async (context) => {
    const params = reviewEventParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
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
  app.post("/api/events/:eventId/review/transitions", async (context) => {
    const params = reviewEventParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
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
  app.notFound((context) =>
    context.json(
      envelope("NOT_FOUND", "The requested resource was not found.", context.get("correlationId")),
      404,
    ),
  );
  app.onError((error, context) => {
    const correlationId = context.get("correlationId") ?? crypto.randomUUID();
    if (error instanceof AuthenticationRequiredError)
      return context.json(envelope("UNAUTHORIZED", "Sign in to continue.", correlationId), 401);
    if (error instanceof CapabilityDeniedError)
      return context.json(
        envelope("FORBIDDEN", "Your account cannot perform this action.", correlationId),
        403,
      );
    if (error instanceof MalformedJsonError)
      return context.json(
        envelope("VALIDATION_FAILED", "Request body must be valid JSON.", correlationId),
        400,
      );
    if (error instanceof ReviewValidationError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The review request is invalid.",
          correlationId,
          error.fields,
        ),
        400,
      );
    if (error instanceof ReviewConflictError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Resolve the declared conflict before evaluating.",
          correlationId,
        ),
        409,
      );
    if (error instanceof ReviewNotFoundError)
      return context.json(
        envelope("NOT_FOUND", "The requested resource was not found.", correlationId),
        404,
      );
    logger.error(
      {
        correlationId,
        method: context.req.method,
        path: context.req.path,
        status: 500,
        operation: context.get("operation"),
        actorId: context.get("actor")?.id,
        errorName: error.name,
      },
      "request.exception",
    );
    return context.json(envelope("INTERNAL_ERROR", "Something went wrong.", correlationId), 500);
  });
  return app;
}
