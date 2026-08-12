/**
 * Event identity and configuration.
 *
 * Owned by the `events` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  createEventInputSchema,
  createEventResponseSchema,
  eventIdParamsSchema,
  eventListResponseSchema,
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
  },
};
