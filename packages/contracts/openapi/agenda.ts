/**
 * Rooms, tracks, slots, placements and schedule publication.
 *
 * Owned by the `agenda` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  agendaDraftSchema,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaPublicationHeadersSchema,
  agendaResourcesSchema,
  publishedScheduleSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const agendaPaths: OpenApiFragment = {
  domain: "agenda",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/agenda",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: agendaIdParamsSchema },
      responses: {
        200: {
          description: "Organizer agenda draft and conflicts",
          content: json(z.object({ agenda: agendaDraftSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/agenda/resources",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: agendaIdParamsSchema,
        body: { required: true, content: json(agendaResourcesSchema) },
      },
      responses: {
        200: {
          description: "Configured rooms, tracks, and timeslots",
          content: json(z.object({ agenda: agendaDraftSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/agenda/placements/{placementId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: agendaIdParamsSchema.extend({ placementId: z.string() }),
        body: { required: true, content: json(agendaPlacementSchema) },
      },
      responses: {
        200: {
          description: "Updated draft and conflicts",
          content: json(z.object({ agenda: agendaDraftSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/events/{eventId}/agenda/placements/{placementId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: agendaIdParamsSchema.extend({ placementId: z.string() }) },
      responses: {
        204: { description: "Placement removed" },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/agenda/publications",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: agendaIdParamsSchema,
        headers: agendaPublicationHeadersSchema,
      },
      responses: {
        201: {
          description: "Auditable immutable schedule publication",
          content: json(z.object({ schedule: publishedScheduleSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
  },
};
