import {
  acceptContentInputSchema,
  type ApiErrorEnvelope,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  cfpStateInputSchema,
  communicationsHistoryParamsSchema,
  createTemplateInputSchema,
  createEventInputSchema,
  createProspectInputSchema,
  contentSessionParamsSchema,
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureReviewPlanInputSchema,
  configureProposalStatusesInputSchema,
  declareConflictInputSchema,
  demoSessionInputSchema,
  eventContentParamsSchema,
  eventIdParamsSchema,
  deliveryIdParamsSchema,
  profileParamsSchema,
  prospectListQuerySchema,
  prospectPathSchema,
  type ProposalAcceptanceDto,
  proposalStatusSchema,
  recordProposalDecisionInputSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  saveEvaluationInputSchema,
  setSpeakerPhotoInputSchema,
  speakerAssetParamsSchema,
  taskParamsSchema,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
  uploadSpeakerAssetInputSchema,
  updateProspectInputSchema,
  saveCfpInputSchema,
  submitProposalInputSchema,
  retryDeliveryInputSchema,
  triggerDeliveryInputSchema,
  publicEventProjectionSchema,
  publicEventSlugParamsSchema,
  publicScheduleSchema,
  publicationPreviewResponseSchema,
} from "@greenroom/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { etag, RETAINED_304_HEADERS } from "hono/etag";
import { clientAddress, submissionThrottle } from "./throttle";
import type { EventService } from "../../application/events/event-service";
import {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
  type CommunicationsService,
} from "../../application/communications/communications-service";
import {
  type ContentService,
  SpeakerIdentityUnavailableError,
  SpeakerPhotoInvalidError,
} from "../../application/content/content-service";
import {
  ProposalNotAcceptedError,
  ProposalNotFoundError,
  ProposalSubmitterUnavailableError,
} from "../../application/review/public";
import {
  type CrmService,
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
} from "../../application/crm/public";
import {
  ReviewConflictError,
  ReviewNotFoundError,
  type ReviewService,
  ReviewValidationError,
} from "../../application/review/review-service";
import {
  type CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "../../application/cfp/public";
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
  requireEventCapability,
} from "../../application/identity/actor";
import { createDemoSession, resolveDemoSession } from "../../application/identity/demo-session";
import {
  composePublicSchedule,
  type PublicationService,
} from "../../application/publishing/public";
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
/**
 * The caching policy for a public representation: any cache may keep it, none may use it
 * without asking first. See the middleware that applies it.
 */
const PUBLIC_CACHE_CONTROL = "public, no-cache";

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
) {
  const reviewService =
    reviewOrCfpService && "organizerWorkspace" in reviewOrCfpService
      ? reviewOrCfpService
      : undefined;
  const cfpService =
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

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      checks: { database: "configured", sessionSigning: auth.demoMode ? "configured" : "disabled" },
      providerMode: "sql-r2",
      logFormat: "structured-json",
    }),
  );
  app.get("/api/public/events/:slug", async (context) => {
    const slug = context.req.param("slug");
    if (!publishing || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      return context.json(
        envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
        404,
      );
    const parsed = publicEventProjectionSchema.safeParse(await publishing.publicBySlug(slug));
    if (!parsed.success)
      return context.json(
        envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
        404,
      );
    // Cache policy for this namespace belongs to the `/api/public/*` middleware above, which
    // gives every public representation the same bounded lifetime and an ETag.
    return context.json({ projection: parsed.data });
  });
  app.get("/api/publishing/events/:eventId/preview", async (context) => {
    const parsed = eventIdParamsSchema.safeParse(context.req.param());
    if (!parsed.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    const publication = await publishing?.preview(context.get("actor"), parsed.data.eventId);
    if (!publication)
      return context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    return context.json(publicationPreviewResponseSchema.parse({ publication }));
  });
  for (const action of ["publish", "unpublish"] as const)
    app.post(`/api/publishing/events/:eventId/${action}`, async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const publication =
        action === "publish"
          ? await publishing?.publish(context.get("actor"), parsed.data.eventId)
          : await publishing?.unpublish(context.get("actor"), parsed.data.eventId);
      if (!publication)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      return context.json(publicationPreviewResponseSchema.parse({ publication }));
    });
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
  /*
   * Every event the signed-in actor holds any role on, whatever capabilities that role
   * carries — which is how the public demo identity, who holds no `events:read`, still sees
   * the event it was invited to.
   *
   * It lived at `GET /api/public/events` and answered 401 to anonymous callers, which made
   * "public" a lie and left the one namespace that has to work without a session holding a
   * route that cannot. Registered before `/api/events/:eventId` so the static segment wins
   * over the parameter.
   */
  app.get("/api/events/assigned", async (context) =>
    context.json({ events: (await service.listAssigned(context.get("actor"))).map(eventToDto) }),
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
  app.post("/api/communications/templates", async (context) => {
    requireCapability(context.get("actor"), "communications:manage");
    if (!communications) throw new Error("Communications service is not configured");
    const parsed = createTemplateInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The template is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    return context.json(
      { template: await communications.createTemplate(context.get("actor"), parsed.data) },
      201,
    );
  });
  app.post("/api/communications/deliveries", async (context) => {
    requireCapability(context.get("actor"), "communications:manage");
    if (!communications) throw new Error("Communications service is not configured");
    const parsed = triggerDeliveryInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The delivery trigger is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    return context.json(
      { delivery: await communications.trigger(context.get("actor"), parsed.data) },
      202,
    );
  });
  app.get("/api/communications/history", async (context) => {
    requireCapability(context.get("actor"), "communications:manage");
    if (!communications) throw new Error("Communications service is not configured");
    const parsed = communicationsHistoryParamsSchema.safeParse(context.req.query());
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Organization and event IDs are required.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    return context.json(
      await communications.history(
        context.get("actor"),
        parsed.data.organizationId,
        parsed.data.eventId,
        { limit: parsed.data.limit, cursor: parsed.data.cursor },
      ),
    );
  });
  app.post("/api/communications/deliveries/:deliveryId/retry", async (context) => {
    requireCapability(context.get("actor"), "communications:manage");
    if (!communications) throw new Error("Communications service is not configured");
    const params = deliveryIdParamsSchema.safeParse(context.req.param());
    const query = retryDeliveryInputSchema.safeParse(context.req.query());
    if (!params.success || !query.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The recovery request is invalid.",
          context.get("correlationId"),
        ),
        400,
      );
    return context.json({
      delivery: await communications.retry(
        context.get("actor"),
        query.data.organizationId,
        params.data.deliveryId,
      ),
    });
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
      await content.accept(
        context.get("actor"),
        { eventId: params.data.eventId, proposalId: parsed.data.proposalId },
        context.get("correlationId"),
      ),
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
  /*
   * Which uploaded file is this speaker's headshot.
   *
   * Its own address rather than a field on the PATCH above, because the two carry different
   * authority: the profile text is the speaker's to write, while an organizer of the event
   * may also set or remove the headshot on the programme they run. The service decides which
   * of the two the caller is; a reviewer and an unrelated speaker are refused.
   *
   * Naming a photo publishes nothing. The asset keeps whatever visibility it had, so a
   * private upload stays private and the public page shows initials until an organizer
   * separately marks that asset publishable — `POST /api/speaker-assets/{assetId}/publish`.
   * A file that is not this speaker's, or is not an image, is a 400 naming `assetId`.
   */
  app.put("/api/speaker-profiles/:profileId/photo", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const params = profileParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
        400,
      );
    const parsed = setSpeakerPhotoInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "That profile photo reference is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      profile: await content.setProfilePhoto(
        context.get("actor"),
        params.data.profileId,
        parsed.data.assetId,
      ),
    });
  });
  /* Withdrawing the choice needs no more authority than making it, and keeps the file. */
  app.delete("/api/speaker-profiles/:profileId/photo", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const params = profileParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      profile: await content.clearProfilePhoto(context.get("actor"), params.data.profileId),
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
  app.get("/api/speaker-assets/:assetId", async (context) => {
    const params = speakerAssetParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    // Authorization lives in the service: an asset is public only while it is publishable
    // *and* its event is published; private ones reach only the owning speaker or an
    // organizer of the event. A withheld asset and a missing one are the same 404, so ids
    // cannot be enumerated (`ARC-AUTH-001`).
    const found = await content.readAsset(context.get("actor"), params.data.assetId);
    if (!found)
      return context.json(
        envelope("NOT_FOUND", "The asset was not found.", context.get("correlationId")),
        404,
      );
    // Uploaded bytes never change — there is no replace route — so identity plus upload
    // instant is a strong validator, and the revalidation the policy below demands costs a
    // bodyless 304 rather than the file.
    const validator = `"${found.asset.id}-${found.asset.uploadedAt}"`;
    const headers = {
      // Only bytes served through the *public* door may be stored by a shared cache: the
      // same publishable asset is also served to its owner while the event is unpublished,
      // and that response must never end up in front of the public. Storable, never used
      // unvalidated — returning an asset to private has to be visible on the next request.
      "cache-control": found.publiclyReadable ? PUBLIC_CACHE_CONTROL : "private, no-store",
      etag: validator,
      // Uploaded files are untrusted; never let a browser execute one inline.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    };
    // `context.body` rather than a raw `Response`: a raw one drops the headers prepared by
    // the middleware above, which is how these bytes used to be served with no correlation id.
    if (context.req.header("if-none-match")?.includes(validator))
      return context.body(null, 304, headers);
    return context.body(found.bytes as unknown as ArrayBuffer, 200, {
      ...headers,
      "content-type": found.contentType,
      "content-length": String(found.bytes.byteLength),
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
  /*
   * Publication is reversible. An asset published by mistake goes back to `private`, which
   * closes the public door immediately: the read above serves no lifetime a cache could
   * spend on the withdrawn bytes. Organizer-only, like publishing it.
   */
  app.post("/api/speaker-assets/:assetId/unpublish", async (context) => {
    requireCapability(context.get("actor"), "content:manage");
    const params = speakerAssetParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    return context.json({
      asset: await content.unpublishAsset(context.get("actor"), params.data.assetId),
    });
  });
  /*
   * Deletion removes the row and the stored object together. The speaker who uploaded the
   * file may take it back, and an organizer of the event may remove one that should never
   * have been received. An unknown id and an asset on someone else's event are refused
   * identically, so neither reveals the other (`ARC-AUTH-001`).
   */
  app.delete("/api/speaker-assets/:assetId", async (context) => {
    requireCapability(context.get("actor"), "content:read");
    const params = speakerAssetParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
        400,
      );
    if (!content) throw new Error("Content service is unavailable");
    await content.deleteAsset(context.get("actor"), params.data.assetId);
    return context.body(null, 204);
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
    const document = await content.calendar(context.get("actor"), parsed.data.eventId);
    // RFC 5545 section 3.4 requires at least one component, so a speaker with nothing scheduled
    // has no calendar to download rather than a VCALENDAR every calendar client refuses.
    if (!document)
      return context.json(
        envelope(
          "NOT_FOUND",
          "You have no scheduled sessions to export yet.",
          context.get("correlationId"),
        ),
        404,
      );
    return context.body(document, 200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="greenroom-sessions.ics"',
    });
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
    requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
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
  app.put("/api/events/:eventId/review/statuses", async (context) => {
    const params = reviewEventParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
    const parsed = configureProposalStatusesInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The status configuration is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!reviewService) throw new Error("Review service is not configured");
    return context.json({
      statuses: await reviewService.configureStatuses(
        context.get("actor"),
        params.data.eventId,
        parsed.data.statuses,
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
    requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
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
    requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
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
  /**
   * A content refusal the organizer can act on.
   *
   * The decisions are already durable by the time acceptance runs, so a failure here can never
   * be reported as "the request failed" — that would deny state the server is holding. Every
   * error therefore becomes a per-proposal `decision_only` row. Typed content refusals get copy
   * the organizer can act on; anything else gets the correlation id and is logged at error level,
   * so an infrastructure fault is still diagnosable rather than dressed up as a validation
   * problem. `null` marks the unexpected case for the caller.
   */
  const acceptanceRefusal = (error: unknown) => {
    if (error instanceof ProposalSubmitterUnavailableError)
      return {
        detail: "This proposal has no contact address, so no speaker could be created from it.",
        fieldErrors: {
          "submitter.email": [
            "The published form collected no email address, so no speaker can be created.",
          ],
        },
      };
    if (error instanceof SpeakerIdentityUnavailableError)
      return {
        detail: "The speaker identity could not be created from this proposal.",
        fieldErrors: error.fields,
      };
    if (error instanceof ProposalNotAcceptedError || error instanceof ProposalNotFoundError)
      return {
        detail: "The content domain no longer sees an acceptance decision for this proposal.",
        fieldErrors: { proposalId: ["This proposal is not accepted."] },
      };
    return null;
  };
  app.post("/api/events/:eventId/review/decisions", async (context) => {
    const params = reviewEventParamsSchema.safeParse(context.req.param());
    if (!params.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    requireEventCapability(context.get("actor"), params.data.eventId, "review:manage");
    const parsed = recordProposalDecisionInputSchema.safeParse(await readJson(context.req));
    if (!parsed.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The decision request is invalid.",
          context.get("correlationId"),
          validationFields(parsed.error.issues),
        ),
        400,
      );
    if (!reviewService) throw new Error("Review service is not configured");
    const { eventId } = params.data;
    // Acceptance is one request. Transport composes the two application services — the review
    // decision authorizes the session, and content creates it — so the client never orchestrates
    // across a domain boundary. Neither service imports the other: content depends on review's
    // public `AcceptedProposalQuery`, and review stays unaware of content.
    const contentService = parsed.data.outcome === "accepted" ? content : undefined;
    if (parsed.data.outcome === "accepted") {
      if (!contentService) throw new Error("Content service is unavailable");
      // Checked before anything is recorded: an actor who could not create the session must not
      // leave a decision behind.
      requireCapability(context.get("actor"), "content:manage");
    }
    const decided = await reviewService.decide(
      context.get("actor"),
      eventId,
      parsed.data.proposalIds,
      parsed.data.outcome,
      parsed.data.note,
    );
    const acceptances: ProposalAcceptanceDto[] = [];
    if (contentService)
      for (const { proposalId } of decided.decisions) {
        try {
          const workspace = await contentService.accept(
            context.get("actor"),
            { eventId, proposalId },
            context.get("correlationId"),
          );
          acceptances.push({
            proposalId,
            state: "content",
            sessionId:
              workspace.sessions.find((session) => session.proposalId === proposalId)?.id ?? null,
            detail: "",
            fieldErrors: {},
          });
        } catch (error) {
          const correlationId = context.get("correlationId");
          const refusal = acceptanceRefusal(error) ?? {
            detail: `The session could not be created. Reference: ${correlationId}`,
            fieldErrors: {},
          };
          // The decision is already durable and is not what failed, so it is reported as
          // recorded with the session missing rather than the whole request as refused.
          // Re-posting the identical decision overwrites it and retries the session, which
          // heals the gap. Answering 500 here would deny state the server is holding.
          const fields = {
            correlationId,
            operation: context.get("operation"),
            actorId: context.get("actor")?.id,
            eventId,
            proposalId,
            errorName: error instanceof Error ? error.name : "unknown",
            errorMessage: error instanceof Error ? error.message : String(error),
          };
          // An unexpected fault is still a fault: it is logged at error level so it reaches the
          // same place a 500 would have, even though the response is a truthful 201.
          if (acceptanceRefusal(error)) logger.warn(fields, "review.acceptance.incomplete");
          else logger.error(fields, "review.acceptance.failed");
          acceptances.push({ proposalId, state: "decision_only", sessionId: null, ...refusal });
        }
      }
    return context.json({ ...decided, acceptances }, 201);
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
    requireEventCapability(context.get("actor"), params.data.eventId, "review:evaluate");
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
    requireEventCapability(context.get("actor"), params.data.eventId, "review:evaluate");
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
  app.get("/api/events/:eventId/prospects", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = eventIdParamsSchema.safeParse(context.req.param());
    const query = prospectListQuerySchema.safeParse(context.req.query());
    if (!path.success || !query.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Prospect filters are invalid.",
          context.get("correlationId"),
        ),
        400,
      );
    return context.json({
      prospects: await crm.list(context.get("actor"), path.data.eventId, {
        ...query.data,
        overdueBefore: query.data.overdue ? new Date().toISOString() : undefined,
      }),
    });
  });
  app.post("/api/events/:eventId/prospects", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = eventIdParamsSchema.safeParse(context.req.param());
    const input = createProspectInputSchema.safeParse(await readJson(context.req));
    if (!path.success || !input.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The prospect could not be created.",
          context.get("correlationId"),
        ),
        400,
      );
    return context.json(
      {
        prospect: await crm.create(context.get("actor"), {
          eventId: path.data.eventId,
          ...input.data,
        }),
      },
      201,
    );
  });
  // Registered before `/prospects/:prospectId` so the literal segment is not swallowed by the
  // parameterised route.
  app.get("/api/events/:eventId/prospects/owners", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = eventIdParamsSchema.safeParse(context.req.param());
    if (!path.success)
      return context.json(
        envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
        400,
      );
    return context.json({ owners: await crm.listOwners(context.get("actor"), path.data.eventId) });
  });
  app.get("/api/events/:eventId/prospects/:prospectId", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = prospectPathSchema.safeParse(context.req.param());
    if (!path.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Prospect identity is malformed.",
          context.get("correlationId"),
        ),
        400,
      );
    return context.json({
      prospect: await crm.get(context.get("actor"), path.data.eventId, path.data.prospectId),
    });
  });
  app.patch("/api/events/:eventId/prospects/:prospectId", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = prospectPathSchema.safeParse(context.req.param());
    const input = updateProspectInputSchema.safeParse(await readJson(context.req));
    // Named fields, because one of the ways this refuses a body is subtle: `stage-change`
    // and `conversion` are activity kinds the CRM service narrates for itself, and a client
    // that submits one is told which field it may not write rather than only that something
    // was wrong.
    if (!path.success || !input.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The prospect could not be updated.",
          context.get("correlationId"),
          input.success ? undefined : validationFields(input.error.issues),
        ),
        400,
      );
    return context.json({
      prospect: await crm.update(
        context.get("actor"),
        path.data.eventId,
        path.data.prospectId,
        input.data,
      ),
    });
  });
  app.post("/api/events/:eventId/prospects/:prospectId/convert", async (context) => {
    requireCapability(context.get("actor"), "crm:manage");
    if (!crm) throw new Error("CRM service is not configured");
    const path = prospectPathSchema.safeParse(context.req.param());
    if (!path.success)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Prospect identity is malformed.",
          context.get("correlationId"),
        ),
        400,
      );
    return context.json({
      prospect: await crm.convert(
        context.get("actor"),
        path.data.eventId,
        path.data.prospectId,
        context.get("correlationId"),
      ),
    });
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
  /*
   * The public schedule is addressed by the event's public slug, like every other public
   * route, and is gated on the publication being live: unpublishing has to take the whole
   * public surface down.
   *
   * The slug is not a secrecy measure, and nothing here pretends otherwise: the projection
   * this route reads publishes `event.eventId` to anonymous callers, and that UUID is the
   * address of `GET /api/public/events/{eventId}/cfp` and
   * `POST /api/public/events/{eventId}/submissions`, which is how the public CFP form is
   * fetched and filled in. The slug is the *readable, stable* public name — derived from the
   * event's own name, never a storage id — and using it consistently is what keeps storage
   * identifiers out of the addresses a visitor sees, links, and shares. Authorization is
   * carried by publication state on every one of these routes, never by an unguessable id.
   *
   * Publishing owns "is this event public"; agenda owns the snapshot. Neither reads the
   * other's tables — this route composes their two public application interfaces.
   *
   * What each contributes is deliberate. The agenda publication says *whether* a numbered
   * immutable snapshot exists and *which* one is in force; the published projection says
   * what may be shown. Handing back the agenda snapshot itself published the organizer's
   * whole board — a session still in `draft` came out with its title, and every session
   * and speaker arrived as its storage UUID — on the one route whose entire purpose is the
   * published surface (`ACC-AGENDA`, `PRD-PUB-001`).
   *
   * So the placement detail here is the projection's copy, which is the same copy the event
   * hub serves: the two public views of one session can never disagree. Republishing the
   * agenda advances `version` before that detail follows, exactly as republishing any other
   * source moves ahead of the snapshot until the organizer publishes the site again — which
   * is the rule `PRD-PUB-001` states for the whole public surface, and which the publishing
   * workspace already reports on screen.
   */
  app.get("/api/public/events/:slug/schedule", async (context) => {
    const notPublished = () =>
      context.json(
        envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
        404,
      );
    const parsed = publicEventSlugParamsSchema.safeParse(context.req.param());
    // An unknown slug, a malformed slug, an unpublished event and an unpublished agenda
    // are one indistinguishable response, so the route cannot be used to enumerate events.
    if (!parsed.success || !agenda || !publishing) return notPublished();
    const projection = await publishing.publicBySlug(parsed.data.slug);
    if (!projection) return notPublished();
    const publication = await agenda.published(projection.event.eventId);
    if (!publication) return notPublished();
    // Parsed, not merely composed: the contract is what leaves the process, and a stored
    // snapshot that cannot satisfy it is withheld exactly like an unpublished one.
    const schedule = publicScheduleSchema.safeParse(composePublicSchedule(projection, publication));
    if (!schedule.success) return notPublished();
    return context.json({ schedule: schedule.data });
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
    if (error instanceof ProspectNotFoundError)
      return context.json(
        envelope("NOT_FOUND", "The requested resource was not found.", correlationId),
        404,
      );
    if (error instanceof ProspectContactRequiredError)
      return context.json(
        envelope("VALIDATION_FAILED", "A contact is required before conversion.", correlationId),
        409,
      );
    if (error instanceof ProspectAlreadyConvertedError)
      return context.json(
        envelope("VALIDATION_FAILED", "Converted prospects cannot be changed.", correlationId),
        409,
      );
    // An owner the identity directory does not list for this event is a typed refusal with the
    // offending field named, not the foreign-key crash the organizer used to see as a 500.
    if (error instanceof ProspectOwnerNotEligibleError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "Choose an owner who works on this event.",
          correlationId,
          error.fields,
        ),
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
    // Acceptance failures are the caller's, never the server's. An unknown id and one belonging
    // to another event collapse to the same 404 so acceptance cannot enumerate foreign proposals.
    if (error instanceof ProposalNotFoundError)
      return context.json(
        envelope("NOT_FOUND", "The requested resource was not found.", correlationId),
        404,
      );
    if (error instanceof ProposalNotAcceptedError)
      return context.json(
        envelope(
          "CONFLICT",
          "Accept this proposal in review before scheduling it.",
          correlationId,
          {
            proposalId: ["This proposal has no recorded acceptance decision."],
          },
        ),
        409,
      );
    if (error instanceof ProposalSubmitterUnavailableError)
      return context.json(
        envelope("VALIDATION_FAILED", "This proposal has no contact address.", correlationId, {
          "submitter.email": [
            "The published form collected no email address, so no speaker can be created.",
          ],
        }),
        400,
      );
    if (error instanceof SpeakerIdentityUnavailableError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "The speaker identity could not be created.",
          correlationId,
          error.fields,
        ),
        400,
      );
    // A slide deck, or a file belonging to somebody else, named as a headshot. The caller can
    // fix it by choosing a different upload, so it is a field error rather than a bare 400.
    if (error instanceof SpeakerPhotoInvalidError)
      return context.json(
        envelope(
          "VALIDATION_FAILED",
          "That file cannot be used as a profile photo.",
          correlationId,
          error.fields,
        ),
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
    if (error instanceof CommunicationsInputError)
      return context.json(envelope("VALIDATION_FAILED", error.message, correlationId), 400);
    if (error instanceof CommunicationsNotFoundError)
      return context.json(envelope("NOT_FOUND", error.message, correlationId), 404);
    if (error instanceof CommunicationsConflictError)
      return context.json(envelope("CONFLICT", error.message, correlationId), 409);
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
