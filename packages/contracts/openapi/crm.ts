/**
 * Prospects, their owners, and conversion.
 *
 * Owned by the `crm` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  createProspectInputSchema,
  eventIdParamsSchema,
  prospectListQuerySchema,
  prospectListResponseSchema,
  prospectOwnerListResponseSchema,
  prospectPathSchema,
  prospectResponseSchema,
  updateProspectInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const crmPaths: OpenApiFragment = {
  domain: "crm",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema, query: prospectListQuerySchema },
      responses: {
        200: { description: "Event prospect pipeline", content: json(prospectListResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/prospects",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(createProspectInputSchema) },
      },
      responses: {
        201: { description: "Created prospect", content: json(prospectResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects/owners",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "Users assignable as the owner of a prospect on this event",
          content: json(prospectOwnerListResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects/{prospectId}",
      security: [{ sessionCookie: [] }],
      request: { params: prospectPathSchema },
      responses: {
        200: {
          description: "Prospect with contacts and CRM history",
          content: json(prospectResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/events/{eventId}/prospects/{prospectId}",
      security: [{ sessionCookie: [] }],
      request: {
        params: prospectPathSchema,
        body: { required: true, content: json(updateProspectInputSchema) },
      },
      responses: {
        200: { description: "Updated prospect", content: json(prospectResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/prospects/{prospectId}/convert",
      security: [{ sessionCookie: [] }],
      request: { params: prospectPathSchema },
      responses: {
        200: {
          description: "Idempotently converted prospect",
          content: json(prospectResponseSchema),
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
