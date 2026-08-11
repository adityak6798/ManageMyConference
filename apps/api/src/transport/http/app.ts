/**
 * The HTTP composition root.
 *
 * This file owns what is true of *every* request — correlation, session resolution, the
 * public-namespace cache and CORS policy, readiness, and the last-resort error boundary — and
 * nothing that is true of one domain. Each domain's routes live in `routes/<domain>.ts` and
 * are listed once in `routes/registry.ts`.
 *
 * It used to own all of it: 1838 lines, 57 routes, and an `onError` chain naming every
 * domain's error classes. Seven feature branches modifying the same file is what made merging
 * them a manual conflict resolution over code neither branch had changed the meaning of.
 *
 * @spec PRD-IAM-001 PRD-IAM-002 PRD-EVT-001 ARC-001 ARC-DOM-001
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { etag, RETAINED_304_HEADERS } from "hono/etag";
import type { AgendaService } from "../../application/agenda/public";
import type { CfpService } from "../../application/cfp/public";
import type { CommunicationsService } from "../../application/communications/communications-service";
import type { ContentService } from "../../application/content/content-service";
import type { CrmService } from "../../application/crm/public";
import type { EventService } from "../../application/events/event-service";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../../application/identity/actor";
import { resolveDemoSession } from "../../application/identity/demo-session";
import type { PublicationService } from "../../application/publishing/public";
import type { ReviewService } from "../../application/review/review-service";
import type { HttpDependencies } from "./routes/contract";
import { assertNoDuplicateRoutes, routeModules } from "./routes/registry";
import {
  type BuildIdentity,
  envelope,
  type HttpContext,
  MalformedJsonError,
  PUBLIC_CACHE_CONTROL,
  type RuntimeAuthConfig,
  type StructuredLogger,
  type Variables,
} from "./runtime";

export type { BuildIdentity, RuntimeAuthConfig, StructuredLogger } from "./runtime";
export type { HttpDependencies } from "./routes/contract";

const correlationPattern = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Build the app from an explicit, named set of services.
 *
 * Prefer this over `createHttpApp`. The positional form is kept because a great many tests
 * call it, and rewriting them all is a change of a different shape than this one.
 */
export function createHttpAppFrom(dependencies: HttpDependencies) {
  const { logger, auth, build } = dependencies;
  // A route claimed by two domains is a merge accident, and the losing registration simply
  // never runs. Failing at construction names both domains instead.
  assertNoDuplicateRoutes(routeModules);
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

  /*
   * `/api/public/*` is a public API, and these three middlewares are what make that true
   * for every route in it at once rather than route by route.
   *
   * CORS: the namespace is anonymous by construction — no route under it reads the session
   * — so `Access-Control-Allow-Origin: *` without credentials is safe, and it is what lets a
   * conference's own site embed the schedule. `OPTIONS` used to fall through to `notFound`
   * and 404, which no preflight accepts.
   *
   * ETag + caching: the embed hits these endpoints on every page load, so `no-store` was
   * paying full price every time. The saving is taken with a validator, not with a
   * lifetime. `PRD-PUB-001` promises that the applicant view reflects close and reopen
   * immediately and that unpublishing removes the public snapshot immediately; any
   * `max-age` at all is a window in which a browser answers from its own store without
   * asking us, so a closed CFP would keep advertising itself for the length of that
   * window. `no-cache` keeps the response storable but forces revalidation on every read,
   * and the ETag makes an unchanged answer a bodyless 304 — the bandwidth `#64` wanted,
   * with no staleness to trade for it. Anything that is not a 200 — a 404 for an
   * unpublished event, a submission response — is `no-store`, so a cache cannot pin
   * "not published" over a later publish.
   */
  app.use(
    "/api/public/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
      allowHeaders: ["content-type", "if-none-match", "x-correlation-id"],
      exposeHeaders: ["etag", "x-correlation-id"],
      maxAge: 86_400,
    }),
  );
  app.use(
    "/api/public/*",
    // A 304 keeps only the headers the RFC names, and two of ours have to outlive that.
    // The correlation id is the only way a caller can report a bad response. The CORS
    // headers matter even more: `allowHeaders` invites a third-party page to send
    // `If-None-Match`, and a browser rejects the 304 that comes back unless it still
    // carries `Access-Control-Allow-Origin`, so revalidation would fail from every origin
    // the namespace exists to serve.
    etag({
      retainedHeaders: [
        ...RETAINED_304_HEADERS,
        "x-correlation-id",
        "access-control-allow-origin",
        "access-control-expose-headers",
      ],
    }),
  );
  app.use("/api/public/*", async (context, next) => {
    await next();
    // HEAD is advertised in `allowMethods` and answered by the same handlers as GET, so it
    // carries the same policy; anything else, and any non-200, is never stored.
    const cacheable =
      (context.req.method === "GET" || context.req.method === "HEAD") && context.res.status === 200;
    context.res.headers.set("cache-control", cacheable ? PUBLIC_CACHE_CONTROL : "no-store");
  });

  /*
   * `/health` is also mounted under `/api` so that a caller reaching the Worker *through the
   * web dev server's proxy* can read the same identity. The browser suite uses exactly that to
   * prove the Vite server in front of it is proxying to this API and not to another
   * checkout's; the proxy forwards `/api/*` only, so an unprefixed `/health` could never
   * answer that question.
   */
  const health = (context: HttpContext) =>
    context.json({
      status: "ok",
      checks: { database: "configured", sessionSigning: auth.demoMode ? "configured" : "disabled" },
      providerMode: "sql-r2",
      logFormat: "structured-json",
      // Omitted rather than set to undefined: a deployed instance reports no build identity at
      // all, and `exactOptionalPropertyTypes` makes that distinction the type system's problem.
      ...(build ? { build } : {}),
    });
  app.get("/health", health);
  app.get("/api/health", health);

  for (const module of routeModules) module.register(app, dependencies);

  app.notFound((context) =>
    context.json(
      envelope("NOT_FOUND", "The requested resource was not found.", context.get("correlationId")),
      404,
    ),
  );
  app.onError((error, context) => {
    const correlationId = context.get("correlationId") ?? crypto.randomUUID();
    // Transport-wide refusals. Everything below them belongs to a domain, and each domain
    // translates its own — so a new domain adds no case to this function.
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
    for (const module of routeModules) {
      const translated = module.translateError?.(error);
      if (translated)
        return context.json(
          envelope(translated.code, translated.message, correlationId, translated.fields),
          translated.status,
        );
    }
    logger.error(
      {
        correlationId,
        method: context.req.method,
        path: context.req.path,
        status: 500,
        operation: context.get("operation"),
        actorId: context.get("actor")?.id,
        errorName: error.name,
        // The response body never carries these; the log is the only place a
        // correlation id can be turned back into a cause (ARC-OBS-001).
        errorMessage: error.message,
        // Stacks name internal paths, so they stay in development only. `demoMode`
        // is refused outside ENVIRONMENT=development by `runtimeAuth`.
        ...(auth.demoMode ? { errorStack: error.stack } : {}),
        ...(error.cause instanceof Error
          ? { errorCauseName: error.cause.name, errorCauseMessage: error.cause.message }
          : {}),
      },
      "request.exception",
    );
    return context.json(envelope("INTERNAL_ERROR", "Something went wrong.", correlationId), 500);
  });
  return app;
}

/**
 * The positional form, preserved for existing callers.
 *
 * The fourth parameter used to accept any one of five services and was sorted out at runtime
 * by testing for a method on it. That behaviour is kept exactly, because tests rely on it, but
 * new code should call `createHttpAppFrom` with named services instead.
 */
// @spec PRD-IAM-001 PRD-IAM-002 PRD-EVT-001
export function createHttpApp(
  service: EventService,
  logger: StructuredLogger,
  auth: RuntimeAuthConfig,
  reviewOrCfpService?:
    | ReviewService
    | CfpService
    | CrmService
    | CommunicationsService
    | PublicationService,
  cfpServiceArgument?: CfpService,
  content?: ContentService,
  crmArgument?: CrmService,
  agenda?: AgendaService,
  communicationsArgument?: CommunicationsService,
  publishingArgument?: PublicationService,
  buildIdentity?: BuildIdentity,
) {
  const review =
    reviewOrCfpService && "organizerWorkspace" in reviewOrCfpService
      ? reviewOrCfpService
      : undefined;
  const cfp =
    cfpServiceArgument ??
    (reviewOrCfpService && "getForOrganizer" in reviewOrCfpService
      ? reviewOrCfpService
      : undefined);
  const crm =
    crmArgument ??
    (reviewOrCfpService && "convert" in reviewOrCfpService ? reviewOrCfpService : undefined);
  const communications =
    communicationsArgument ??
    (reviewOrCfpService && "createTemplate" in reviewOrCfpService ? reviewOrCfpService : undefined);
  const publishing =
    publishingArgument ??
    (reviewOrCfpService && "publicBySlug" in reviewOrCfpService ? reviewOrCfpService : undefined);
  return createHttpAppFrom({
    events: service,
    logger,
    auth,
    review,
    cfp,
    content,
    crm,
    agenda,
    communications,
    publishing,
    build: buildIdentity,
  });
}
