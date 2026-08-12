/**
 * The public projection, its organizer preview, and the published schedule.
 *
 * Owned by the `publishing` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  eventIdParamsSchema,
  itineraryCreatedResponseSchema,
  itineraryInputSchema,
  itineraryResponseSchema,
  itineraryTokenParamsSchema,
  publicationPreviewResponseSchema,
  publicationSettingsInputSchema,
  publicEventResponseSchema,
  publicEventSlugParamsSchema,
  publicScheduleSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const publishingPaths: OpenApiFragment = {
  domain: "publishing",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/public/events/{slug}",
      request: { params: publicEventSlugParamsSchema },
      responses: {
        200: {
          description: "Immutable public event snapshot",
          content: json(publicEventResponseSchema),
        },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/public/events/{slug}/schedule",
      request: { params: publicEventSlugParamsSchema },
      responses: {
        200: {
          description:
            "Sessions the published projection places, under the agenda publication in force",
          content: json(z.object({ schedule: publicScheduleSchema })),
        },
        404: errorResponse,
        500: errorResponse,
      },
    });
    // The three organizer actions differ only in verb and description, so they are declared
    // once rather than copied three times.
    for (const action of ["preview", "publish", "unpublish"] as const)
      registry.registerPath({
        method: action === "preview" ? "get" : "post",
        path: `/api/publishing/events/{eventId}/${action}`,
        security: [{ sessionCookie: [] }, { eventBearer: [] }],
        request: { params: eventIdParamsSchema },
        responses: {
          200: {
            description: `Publication ${action}`,
            content: json(publicationPreviewResponseSchema),
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      });
    /*
     * Attendee itineraries. No security scheme, and that is the design rather than an
     * omission: the token in the path is the whole of the authorization, because the
     * namespace's `Access-Control-Allow-Origin: *` policy forbids credentials.
     */
    registry.registerPath({
      method: "post",
      path: "/api/public/events/{slug}/itinerary",
      request: {
        params: publicEventSlugParamsSchema,
        body: { required: false, content: json(itineraryInputSchema) },
      },
      responses: {
        201: {
          description: "A new itinerary, and the only response that carries its token",
          content: json(itineraryCreatedResponseSchema),
        },
        404: errorResponse,
        429: errorResponse,
        500: errorResponse,
      },
    });
    for (const method of ["get", "post"] as const)
      registry.registerPath({
        method,
        path: "/api/public/itineraries/{token}",
        request: {
          params: itineraryTokenParamsSchema,
          ...(method === "post"
            ? { body: { required: true, content: json(itineraryInputSchema) } }
            : {}),
        },
        responses: {
          200: {
            description: method === "get" ? "The stored itinerary" : "The saved itinerary",
            content: json(itineraryResponseSchema),
          },
          ...(method === "post" ? { 400: errorResponse } : {}),
          404: errorResponse,
          500: errorResponse,
        },
      });
    registry.registerPath({
      method: "patch",
      path: "/api/publishing/events/{eventId}/settings",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(publicationSettingsInputSchema) },
      },
      responses: {
        200: {
          description: "Public details saved to the draft; the published snapshot is untouched",
          content: json(publicationPreviewResponseSchema),
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
