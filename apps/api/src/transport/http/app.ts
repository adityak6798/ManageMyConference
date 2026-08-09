import {
  type ApiErrorEnvelope,
  createEventInputSchema,
  demoSessionInputSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { EventService } from "../../application/events/event-service";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../../application/identity/actor";
import { createDemoSession, resolveDemoSession } from "../../application/identity/demo-session";
import { createEventInputToCommand, eventToDto } from "./event-mappers";

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
type Variables = { correlationId: string; actor: Actor | null; operation: string };
export interface RuntimeAuthConfig {
  demoMode: boolean;
  sessionSecret?: string;
  now?: () => number;
}
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
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-correlation-id");
    const correlationId =
      supplied && correlationPattern.test(supplied) ? supplied : crypto.randomUUID();
    context.set("correlationId", correlationId);
    const sessionSecret = auth.demoMode ? auth.sessionSecret : undefined;
    if (auth.demoMode && !sessionSecret) throw new Error("Demo mode requires SESSION_SECRET");
    context.set(
      "actor",
      sessionSecret
        ? await resolveDemoSession(
            getCookie(context, "greenroom_session"),
            sessionSecret,
            (auth.now ?? Date.now)(),
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
    if (!sessionSecret) throw new Error("Demo mode requires SESSION_SECRET");
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
  app.get("/api/events", async (context) =>
    context.json({ events: (await service.list(context.get("actor"))).map(eventToDto) }),
  );
  app.post("/api/events", async (context) => {
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
    logger.error(
      {
        correlationId,
        method: context.req.method,
        path: context.req.path,
        status: 500,
        operation: context.get("operation"),
        actorId: context.get("actor")?.id,
        errorName: error.name,
        errorMessage: error.message,
      },
      "request.exception",
    );
    return context.json(envelope("INTERNAL_ERROR", "Something went wrong.", correlationId), 500);
  });
  return app;
}
