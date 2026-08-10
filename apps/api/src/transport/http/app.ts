import {
  acceptContentInputSchema,
  type ApiErrorEnvelope,
  createEventInputSchema,
  contentSessionParamsSchema,
  demoSessionInputSchema,
  eventContentParamsSchema,
  eventIdParamsSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  speakerAssetParamsSchema,
  taskParamsSchema,
  updateSpeakerProfileInputSchema,
  updateContentSessionInputSchema,
  uploadSpeakerAssetInputSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { EventService } from "../../application/events/event-service";
import type { ContentService } from "../../application/content/content-service";
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
  content?: ContentService,
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
      providerMode: "sql-r2",
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
  app.get("/api/events/:eventId/content", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const parsed = eventContentParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json(await content.workspace(context.get("actor"), parsed.data.eventId));
  });
  app.post("/api/events/:eventId/content/accept", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const params = eventContentParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    const parsed = acceptContentInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Accepted content is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json(
      await content.accept(context.get("actor"), { eventId: params.data.eventId, ...parsed.data }),
      201,
    );
  });
  app.patch("/api/speaker-profiles/:profileId", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const params = profileParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
        400,
      );
    const parsed = updateSpeakerProfileInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Speaker profile is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      profile: await content.updateMyProfile(
        context.get("actor"),
        params.data.profileId,
        parsed.data,
      ),
    });
  });
  app.post("/api/events/:eventId/tasks/:taskId/complete", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const eventParams = eventContentParamsSchema.safeParse(context.req.param());
    const taskParams = taskParamsSchema.safeParse(context.req.param());
    if (!eventParams.success || !taskParams.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Task reference is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json(
      await content.completeTask(
        context.get("actor"),
        taskParams.data.taskId,
        eventParams.data.eventId,
      ),
    );
  });
  app.post("/api/speaker-tasks", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const parsed = requestSpeakerTaskInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Speaker task is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json(
      { task: await content.requestTask(context.get("actor"), parsed.data) },
      201,
    );
  });
  app.post("/api/speaker-messages", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const parsed = recordSpeakerMessageInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Speaker message is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json(
      { message: await content.recordMessage(context.get("actor"), parsed.data) },
      201,
    );
  });
  app.patch("/api/content-sessions/:sessionId", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const params = contentSessionParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Session ID is malformed.", context.get("correlationId")),
        400,
      );
    const parsed = updateContentSessionInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Session content is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      session: await content.updateSession(
        context.get("actor"),
        params.data.sessionId,
        parsed.data,
      ),
    });
  });
  app.post("/api/speaker-assets/:assetId/publish", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const params = speakerAssetParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      asset: await content.publishAsset(context.get("actor"), params.data.assetId),
    });
  });
  app.post("/api/speaker-assets", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const parsed = uploadSpeakerAssetInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Speaker asset is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    const binary = atob(parsed.data.contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return context.json(
      { asset: await content.upload(context.get("actor"), { ...parsed.data, bytes }) },
      201,
    );
  });
  app.get("/api/events/:eventId/speaker-calendar.ics", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const parsed = eventContentParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.body(await content.calendar(context.get("actor"), parsed.data.eventId), 200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="greenroom-sessions.ics"',
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
