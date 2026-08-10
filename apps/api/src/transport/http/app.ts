import {
  type ApiErrorEnvelope,
  cfpStateInputSchema,
  createEventInputSchema,
  demoSessionInputSchema,
  eventIdParamsSchema,
  saveCfpInputSchema,
  submitProposalInputSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { EventService } from "../../application/events/event-service";
import {
  type CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "../../application/cfp/public";
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
  cfpService?: CfpService,
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
  app.get("/api/public/events", async (context) =>
    context.json({ events: (await service.listAssigned(context.get("actor"))).map(eventToDto) }),
  );
  app.post("/api/public/events/:eventId/submissions", async (context) => {
    if (!cfpService) throw new CfpUnavailableError("CFP service is unavailable");
    const params = eventIdParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
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
    if (error instanceof CfpValidationError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Review the highlighted proposal fields.",
          correlationId,
          error.fieldErrors,
        ),
        400,
      );
    if (error instanceof CfpStateError)
      return context.json(envelope("VALIDATION_FAILED", error.message, correlationId), 400);
    if (error instanceof CfpUnavailableError)
      return context.json(envelope("NOT_FOUND", error.message, correlationId), 404);
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
