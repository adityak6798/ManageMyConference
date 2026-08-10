import {
  type ApiErrorEnvelope,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  createEventInputSchema,
  demoSessionInputSchema,
  eventIdParamsSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { EventService } from "../../application/events/event-service";
import {
  AgendaConflictError,
  AgendaNotFoundError,
  AgendaResourceInUseError,
  type AgendaService,
} from "../../application/agenda/public";
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
  agenda?: AgendaService,
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
  app.get("/api/events/:eventId/agenda", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
    const parsed = agendaIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    return context.json({ agenda: await agenda.draft(context.get("actor"), parsed.data.eventId) });
  });
  app.put("/api/events/:eventId/agenda/resources", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
    requireCapability(context.get("actor"), "agenda:manage");
    const params = agendaIdParamsSchema.safeParse(context.req.param());
    const body = agendaResourcesSchema.safeParse(await readJson(context.req));
    if (!params.success || !body.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Agenda resources are invalid.",
          context.get("correlationId"),
          body.success ? undefined : validationFields(body.error.issues),
        ),
        400,
      );
    return context.json({
      agenda: await agenda.configure(context.get("actor"), params.data.eventId, body.data),
    });
  });
  app.put("/api/events/:eventId/agenda/placements/:placementId", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
    requireCapability(context.get("actor"), "agenda:manage");
    const params = agendaIdParamsSchema.safeParse(context.req.param());
    const body = agendaPlacementSchema.safeParse(await readJson(context.req));
    if (!params.success || !body.success || body.data.id !== context.req.param("placementId"))
      return context.json(
        envelope("VALIDATION_FAILED", "Placement is invalid.", context.get("correlationId")),
        400,
      );
    return context.json({
      agenda: await agenda.place(context.get("actor"), params.data.eventId, body.data),
    });
  });
  app.delete("/api/events/:eventId/agenda/placements/:placementId", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
    const parsed = agendaIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    await agenda.remove(
      context.get("actor"),
      parsed.data.eventId,
      context.req.param("placementId"),
    );
    return context.body(null, 204);
  });
  app.post("/api/events/:eventId/agenda/publications", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
    const parsed = agendaIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    return context.json(
      { schedule: await agenda.publish(context.get("actor"), parsed.data.eventId) },
      201,
    );
  });
  app.get("/api/public/events/:eventId/schedule", async (context) => {
    if (!agenda) throw new AgendaNotFoundError("Schedule not configured");
    const parsed = agendaIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    const schedule = await agenda.published(parsed.data.eventId);
    if (!schedule) throw new AgendaNotFoundError("Published schedule not found");
    return context.json({ schedule });
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
    if (error instanceof AgendaConflictError)
      return context.json(
        envelope(
          "AGENDA_CONFLICT",
          "Resolve schedule conflicts before publishing.",
          correlationId,
          {
            conflicts: error.conflicts.map(
              ({ kind, resourceId, message }) => `${kind}:${resourceId}: ${message}`,
            ),
          },
        ),
        409,
      );
    if (error instanceof AgendaNotFoundError)
      return context.json(
        envelope("NOT_FOUND", "The requested resource was not found.", correlationId),
        404,
      );
    if (error instanceof AgendaResourceInUseError)
      return context.json(envelope("VALIDATION_FAILED", error.message, correlationId), 409);
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
