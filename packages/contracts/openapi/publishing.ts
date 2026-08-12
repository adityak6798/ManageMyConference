/**
 * The public projection, its organizer preview, and the published schedule.
 *
 * Owned by the `publishing` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  eventIdParamsSchema,
  publicEventResponseSchema,
  publicEventSlugParamsSchema,
  publicationPreviewResponseSchema,
  publicationSettingsInputSchema,
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
