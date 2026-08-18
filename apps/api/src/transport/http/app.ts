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
import { API_CONTRACT_VERSION, API_VERSION_HEADER } from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { etag, RETAINED_304_HEADERS } from "hono/etag";
import type { AgendaService } from "../../application/agenda/public";
import type { AccelEventsSyncService } from "../../application/communications/public";
import type { CfpService } from "../../application/cfp/public";
import type { CommunicationsService } from "../../application/communications/public";
import type { ContentService } from "../../application/content/content-service";
import type { SpeakerCalendarInviteService } from "../../application/content/public";
import type { CrmService } from "../../application/crm/public";
import type { EventService } from "../../application/events/event-service";
import type { MembershipService } from "../../application/identity/membership";
import type { Actor } from "../../application/identity/actor";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../../application/identity/actor";
import { resolveDemoSession } from "../../application/identity/demo-session";
import { resolveEventToken, resolveUserSession } from "../../application/identity/real-auth";
import type { ItineraryService, PublicationService } from "../../application/publishing/public";
import type { ReviewService } from "../../application/review/review-service";
import type { HttpDependencies, RouteModule } from "./routes/contract";
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

export type { HttpDependencies } from "./routes/contract";
export type {
  BuildIdentity,
  GoogleAuthProvider,
  RuntimeAuthConfig,
  StructuredLogger,
} from "./runtime";

const correlationPattern = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Build the app from an explicit, named set of services.
 *
 * Prefer this over `createHttpApp`. The positional form is kept because a great many tests
 * call it, and rewriting them all is a change of a different shape than this one.
 */
export function createHttpAppFrom(
  dependencies: HttpDependencies,
  /**
   * The modules to mount, for a test that needs a surface this registry does not describe.
   *
   * Production passes nothing. It exists so the properties that must hold *whatever* the
   * registration order is can be asserted against an order deliberately chosen to break them.
   */
  modules: readonly RouteModule[] = routeModules,
) {
  const { logger, auth, build } = dependencies;
  // A route claimed by two domains is a merge accident, and the losing registration simply
  // never runs. Failing at construction names both domains instead.
  assertNoDuplicateRoutes(modules);
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-correlation-id");
    const correlationId =
      supplied && correlationPattern.test(supplied) ? supplied : crypto.randomUUID();
    context.set("correlationId", correlationId);
    context.header(API_VERSION_HEADER, API_CONTRACT_VERSION);
    const authorization = context.req.header("authorization");
    const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
    const cookie = getCookie(context, "greenroom_session");
    const at = (auth.now ?? Date.now)();

    /*
     * Two doors, one cookie name, and no ambiguity between them.
     *
     * A demo-mode deployment that also has Google configured holds both kinds of credential at
     * once, so the real session is tried first and the persona cookie second. That order is safe
     * because the two token grammars are mutually unparseable — a demo token is
     * `persona.expiry.signature` and `resolveUserSession` refuses anything that is not exactly
     * two dot-separated parts, while `resolveDemoSession` refuses anything whose first part is
     * not a known persona. Neither can be mistaken for the other even though both are signed
     * with `SESSION_SECRET`.
     *
     * `authentication` follows what actually resolved rather than what the deployment mode is,
     * so a real Google session on a demo deployment is reported as a `session` and a persona
     * cookie as `demo`. That is a description of the credential, not a grant: the one reader of
     * this variable, `/api/auth/tokens`, refuses every caller on a demo deployment before it
     * looks at it. Event-scoped bearer tokens are a non-demo feature and stay one.
     */
    let resolved: Actor | null = null;
    let kind: Variables["authentication"] = "none";
    if (auth.demoMode) {
      if (auth.google)
        resolved = await resolveUserSession(
          cookie,
          auth.sessionSecret,
          at,
          auth.google.resolveUserActor,
          (id, now) => auth.sessions.find(id, now),
        );
      if (resolved) kind = "session";
      else {
        // A persona cookie names no session record, so this path takes no session lookup at
        // all. That is worth being explicit about: the demo population is seeded rows, not
        // issued sessions, and giving it a store read would be the first crossing between the
        // two populations rather than a performance detail.
        resolved = await resolveDemoSession(cookie, auth.sessionSecret, at, auth.resolveActor);
        kind = "demo";
      }
    } else if (auth.sessionSecret) {
      if (authorization) {
        resolved = bearer
          ? bearer.startsWith("grn_")
            ? await (auth.resolveApiClient?.(bearer) ?? Promise.resolve(null))
            : await resolveEventToken(
                bearer,
                auth.sessionSecret,
                at,
                auth.resolveActor,
                (id, now) => auth.sessions.find(id, now),
              )
          : null;
        kind = "bearer";
      } else {
        resolved = await resolveUserSession(
          cookie,
          auth.sessionSecret,
          at,
          auth.resolveActor,
          (id, now) => auth.sessions.find(id, now),
        );
        kind = "session";
      }
    }
    context.set("actor", resolved);
    context.set("authentication", resolved ? kind : "none");
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
      exposeHeaders: ["etag", "x-correlation-id", API_VERSION_HEADER],
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
        API_VERSION_HEADER.toLowerCase(),
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
   * checkout's. The dev proxy now forwards the unprefixed `/health`, `/openapi.json` and `/docs`
   * as well — it did not when this mount was written — so the prefixed spelling is no longer the
   * only one that can answer, but it stays: `apps/web/e2e/global-setup.ts` probes it, and a
   * `/api`-prefixed check does not depend on the proxy's route list staying as it is.
   */
  const health = (context: HttpContext) =>
    context.json({
      status: "ok",
      checks: {
        database: "configured",
        sessionSigning: auth.sessionSecret ? "configured" : "disabled",
      },
      providerMode: "sql-r2",
      logFormat: "structured-json",
      // Omitted rather than set to undefined: a deployed instance reports no build identity at
      // all, and `exactOptionalPropertyTypes` makes that distinction the type system's problem.
      ...(build ? { build } : {}),
    });
  app.get("/health", health);
  app.get("/api/health", health);

  /*
   * Every module's request-scoped middleware, before any module's routes.
   *
   * Two loops rather than one, and the separation is the point. Hono applies middleware only to
   * handlers registered after it, so a module mounting `app.use` inside `register` covers the
   * modules listed below it and no others — which made "platform is first in the registry" a
   * load-bearing fact about an array's order that no type, test or comment enforced, and whose
   * breakage would show up as audit records attributed to nobody rather than as a failure
   * (issue #178). Hoisting the mount makes the guarantee independent of the order.
   */
  for (const module of modules) module.registerRequestScope?.(app, dependencies);

  for (const module of modules) module.register(app, dependencies);

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
    for (const module of modules) {
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
  itineraries?: ItineraryService,
  speakerCalendarInvites?: SpeakerCalendarInviteService,
  accelEventsSync?: AccelEventsSyncService,
  membership?: MembershipService,
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
    itineraries,
    speakerCalendarInvites,
    accelEventsSync,
    membership,
    build: buildIdentity,
  });
}
