/**
 * Event identity and configuration.
 *
 * Owned by the `events` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  applyEventTemplateInputSchema,
  captureEventTemplateVersionInputSchema,
  createEventInputSchema,
  createEventResponseSchema,
  duplicateEventTemplateInputSchema,
  eventIdParamsSchema,
  eventListResponseSchema,
  eventTemplateCaptureResponseSchema,
  eventTemplateDetailResponseSchema,
  eventTemplateIdParamsSchema,
  eventTemplateListResponseSchema,
  eventTemplateResponseSchema,
  organizationIdParamsSchema,
  saveEventTemplateInputSchema,
  templateApplicationPlanResponseSchema,
  templateApplicationResponseSchema,
  updateEventInputSchema,
  updateEventResponseSchema,
  updateEventTemplateInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const eventsPaths: OpenApiFragment = {
  domain: "events",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/assigned",
      // Requires a session and answers 401 without one, which is why it is not under
      // `/api/public`: nothing in that namespace may demand a session.
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      responses: {
        200: {
          description: "Events the session holds any role on",
          content: json(eventListResponseSchema),
        },
        401: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/events/{eventId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(updateEventInputSchema) },
      },
      responses: {
        200: { description: "Updated event settings", content: json(updateEventResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "Event identity and basic metadata",
          content: json(createEventResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      responses: {
        200: { description: "Events", content: json(eventListResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events",
      security: [{ sessionCookie: [] }],
      request: { body: { required: true, content: json(createEventInputSchema) } },
      responses: {
        201: { description: "Created event", content: json(createEventResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/event-templates",
      security: [{ sessionCookie: [] }],
      request: { params: organizationIdParamsSchema },
      responses: {
        200: {
          description: "Reusable event templates in this organization",
          content: json(eventTemplateListResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/event-templates",
      security: [{ sessionCookie: [] }],
      request: {
        params: organizationIdParamsSchema,
        body: { required: true, content: json(saveEventTemplateInputSchema) },
      },
      responses: {
        201: {
          description:
            "Template created with version 1, plus what each configuration category contributed",
          content: json(eventTemplateCaptureResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/event-templates/{templateId}",
      security: [{ sessionCookie: [] }],
      request: { params: eventTemplateIdParamsSchema },
      responses: {
        200: {
          description: "One template and its versions, newest first",
          content: json(eventTemplateDetailResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A template owned by another organization answers 404, exactly as an unknown id does.
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/event-templates/{templateId}",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventTemplateIdParamsSchema,
        body: { required: true, content: json(updateEventTemplateInputSchema) },
      },
      responses: {
        200: {
          description: "Renamed or archived template",
          content: json(eventTemplateResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/event-templates/{templateId}/versions",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventTemplateIdParamsSchema,
        body: { required: true, content: json(captureEventTemplateVersionInputSchema) },
      },
      responses: {
        201: {
          description: "A new immutable version captured from a source event",
          content: json(eventTemplateCaptureResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/event-templates/{templateId}/duplications",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventTemplateIdParamsSchema,
        body: { required: true, content: json(duplicateEventTemplateInputSchema) },
      },
      responses: {
        201: {
          description: "A new template holding a copy of this one's newest version",
          content: json(eventTemplateCaptureResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/template-application-previews",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(applyEventTemplateInputSchema) },
      },
      responses: {
        200: {
          description: "What applying this version would copy, exclude and refuse. Writes nothing",
          content: json(templateApplicationPlanResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/template-applications",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(applyEventTemplateInputSchema) },
      },
      responses: {
        200: {
          description:
            "Per-category outcome. Repeating the same call converges rather than duplicating, and a failed category does not roll back the ones that succeeded",
          content: json(templateApplicationResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
  },
};
