/**
 * Readiness. Not a domain surface: it belongs to the transport itself.
 *
 * Owned by the `platform` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  eventIdParamsSchema,
  healthResponseSchema,
  organizerOverviewResponseSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const platformPaths: OpenApiFragment = {
  domain: "platform",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/health",
      responses: {
        200: { description: "Runtime readiness", content: json(healthResponseSchema) },
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/overview",
      description: "Organizer landing-page composition with independently degradable panels.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Organizer overview", content: json(organizerOverviewResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/health",
      description:
        "The same readiness document under the `/api` prefix, so a caller behind a dev proxy that " +
        "forwards `/api/*` can read the build identity of the API it actually reaches.",
      responses: {
        200: { description: "Runtime readiness", content: json(healthResponseSchema) },
        500: errorResponse,
      },
    });
  },
};
