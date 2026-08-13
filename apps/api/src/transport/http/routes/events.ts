/**
 * Event identity and configuration: the list an actor may see, the one they may read, and creating a new one.
 *
 * Owned by the `events` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-EVT-001
 */
import {
  applyEventTemplateInputSchema,
  captureEventTemplateVersionInputSchema,
  createEventInputSchema,
  duplicateEventTemplateInputSchema,
  eventIdParamsSchema,
  eventTemplateIdParamsSchema,
  organizationIdParamsSchema,
  saveEventTemplateInputSchema,
  updateEventInputSchema,
  updateEventTemplateInputSchema,
} from "@greenroom/contracts";
import type { EventTemplateCapture } from "../../../application/events/public";
import {
  EventTemplateNameTakenError,
  EventTemplateNotFoundError,
  EventTemplateRangeError,
  EventTemplateSelectionError,
  EventTemplateStateError,
} from "../../../application/events/public";
import { requireCapability, requireEventCapability } from "../../../application/identity/actor";
import {
  createEventInputToCommand,
  eventTemplateApplicationToDto,
  eventTemplateToDto,
  eventTemplateVersionToDto,
  eventToDto,
  updateEventInputToCommand,
} from "../event-mappers";
import { envelope, type HttpContext, readJson, validationFields } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const malformed = (context: HttpContext, message: string) =>
  context.json(envelope("VALIDATION_FAILED", message, context.get("correlationId")), 400);

const invalid = (
  context: HttpContext,
  message: string,
  error: { issues: { path: PropertyKey[]; message: string }[] },
) =>
  context.json(
    envelope(
      "VALIDATION_FAILED",
      message,
      context.get("correlationId"),
      validationFields(error.issues),
    ),
    400,
  );

const captureToDto = (capture: EventTemplateCapture) => ({
  template: eventTemplateToDto(capture.template),
  version: eventTemplateVersionToDto(capture.version),
  slices: capture.slices,
});

const routes = [
  "GET /api/events",
  "GET /api/events/assigned",
  "POST /api/events",
  "GET /api/events/:eventId",
  "PATCH /api/events/:eventId",
  "GET /api/organizations/:organizationId/event-templates",
  "POST /api/organizations/:organizationId/event-templates",
  "GET /api/event-templates/:templateId",
  "PATCH /api/event-templates/:templateId",
  "POST /api/event-templates/:templateId/versions",
  "POST /api/event-templates/:templateId/duplications",
  "POST /api/events/:eventId/template-application-previews",
  "GET /api/events/:eventId/template-applications",
  "POST /api/events/:eventId/template-applications",
] as const;

export const eventsRoutes: RouteModule = {
  domain: "events",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { events: service, eventTemplates } = dependencies;
    /*
     * A template route reached without the service wired is a composition bug, not a caller
     * mistake, so it is a 500 with the failure logged once — never a 404, which would tell the
     * caller their template does not exist when the truth is that this deployment cannot
     * answer. `HttpDependencies` documents that distinction for the whole transport.
     *
     * Every handler below authorizes *before* it calls this, exactly as `routes/content.ts`
     * does: an unwired deployment still owes an anonymous caller a 401, and a 500 that tells
     * them our composition is incomplete is both wrong and more than they are entitled to know.
     * The service re-checks the same grant — this is the order, not the authorization.
     */
    const templates = () => {
      if (!eventTemplates) throw new Error("The event template service is not composed");
      return eventTemplates;
    };
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
    app.patch("/api/events/:eventId", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "events:settings:update");
      const body = updateEventInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The event settings could not be saved.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const event = await service.update(
        context.get("actor"),
        params.data.eventId,
        updateEventInputToCommand(body.data),
      );
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

    // --- Reusable event templates (issue #102, PRD-EVT-002) ---
    app.get("/api/organizations/:organizationId/event-templates", async (context) => {
      const params = organizationIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Organization ID is malformed.");
      requireCapability(context.get("actor"), "events:read");
      const list = await templates().list(context.get("actor"), params.data.organizationId);
      return context.json({ templates: list.map(eventTemplateToDto) });
    });
    app.post("/api/organizations/:organizationId/event-templates", async (context) => {
      const params = organizationIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Organization ID is malformed.");
      requireCapability(context.get("actor"), "events:create");
      const body = saveEventTemplateInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalid(context, "The template could not be saved.", body.error);
      const capture = await templates().saveFromEvent(context.get("actor"), {
        organizationId: params.data.organizationId,
        name: body.data.name,
        sourceEventId: body.data.sourceEventId,
      });
      return context.json(captureToDto(capture), 201);
    });
    app.get("/api/event-templates/:templateId", async (context) => {
      const params = eventTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Template ID is malformed.");
      requireCapability(context.get("actor"), "events:read");
      const detail = await templates().get(context.get("actor"), params.data.templateId);
      return context.json({
        template: eventTemplateToDto(detail.template),
        versions: detail.versions.map(eventTemplateVersionToDto),
      });
    });
    app.patch("/api/event-templates/:templateId", async (context) => {
      const params = eventTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Template ID is malformed.");
      requireCapability(context.get("actor"), "events:create");
      const body = updateEventTemplateInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalid(context, "The template could not be updated.", body.error);
      const template = await templates().update(
        context.get("actor"),
        params.data.templateId,
        body.data,
      );
      return context.json({ template: eventTemplateToDto(template) });
    });
    app.post("/api/event-templates/:templateId/versions", async (context) => {
      const params = eventTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Template ID is malformed.");
      requireCapability(context.get("actor"), "events:create");
      const body = captureEventTemplateVersionInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalid(context, "The version could not be captured.", body.error);
      const capture = await templates().captureVersion(
        context.get("actor"),
        params.data.templateId,
        body.data.sourceEventId,
      );
      return context.json(captureToDto(capture), 201);
    });
    app.post("/api/event-templates/:templateId/duplications", async (context) => {
      const params = eventTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Template ID is malformed.");
      requireCapability(context.get("actor"), "events:create");
      const body = duplicateEventTemplateInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return invalid(context, "The template could not be duplicated.", body.error);
      const capture = await templates().duplicate(
        context.get("actor"),
        params.data.templateId,
        body.data.name,
      );
      return context.json(captureToDto(capture), 201);
    });
    app.post("/api/events/:eventId/template-application-previews", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Event ID is malformed.");
      requireEventCapability(context.get("actor"), params.data.eventId, "events:settings:read");
      const body = applyEventTemplateInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalid(context, "The preview could not be built.", body.error);
      const plan = await templates().preview(context.get("actor"), params.data.eventId, body.data);
      return context.json({ plan });
    });
    /*
     * What this event was configured from, and what each of those applications actually did.
     *
     * `EventTemplateService.applications` existed, was authorized, and no route reached it — so
     * the per-category outcome was written on every apply and read by nothing (issue #175). The
     * failure mode that closes is quiet: an application whose agenda category was refused looks
     * from every other surface exactly like one that landed whole, and the organizer who would
     * repair it is the one person who never hears about it again.
     */
    app.get("/api/events/:eventId/template-applications", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Event ID is malformed.");
      requireEventCapability(context.get("actor"), params.data.eventId, "events:settings:read");
      const applications = await templates().applications(
        context.get("actor"),
        params.data.eventId,
      );
      return context.json({ applications: applications.map(eventTemplateApplicationToDto) });
    });
    app.post("/api/events/:eventId/template-applications", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success) return malformed(context, "Event ID is malformed.");
      requireEventCapability(context.get("actor"), params.data.eventId, "events:settings:update");
      const body = applyEventTemplateInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalid(context, "The template could not be applied.", body.error);
      const application = await templates().apply(
        context.get("actor"),
        params.data.eventId,
        body.data,
      );
      /*
       * 200 rather than 201, deliberately, and not only because nothing is created at this URL:
       * applying the same version twice is a supported, converging operation, so a status that
       * means "a new thing now exists" would be wrong on the second call and right on the first.
       */
      return context.json({ application });
    });
  },
  translateError(error: unknown) {
    // A template that does not exist and one belonging to another organization answer alike.
    if (error instanceof EventTemplateNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof EventTemplateNameTakenError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof EventTemplateStateError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof EventTemplateRangeError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    // A `slices` key this deployment composes nothing for: the caller's mistake, and named.
    if (error instanceof EventTemplateSelectionError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    return null;
  },
};
