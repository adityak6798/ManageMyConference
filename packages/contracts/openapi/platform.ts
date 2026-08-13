/**
 * Readiness. Not a domain surface: it belongs to the transport itself.
 *
 * Owned by the `platform` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  eventIdParamsSchema,
  healthResponseSchema,
  inboxDismissalInputSchema,
  inboxDismissalParamsSchema,
  inboxDismissalResponseSchema,
  inboxResponseSchema,
  organizerOverviewResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
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
      path: "/api/events/{eventId}/search",
      description:
        "Permission-aware search across one event. Each section is composed under the capability " +
        "its owning domain enforces: a section the caller may not read reports `unauthorized` " +
        "rather than failing the request, and only a genuine rejection reports `failed`.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema, query: searchQuerySchema },
      responses: {
        200: { description: "Search sections", content: json(searchResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/inbox",
      description:
        "Everything waiting on this event, derived on every read. Resolving the underlying " +
        "condition removes an item with no write; the only stored state is a dismissal. " +
        "Categories degrade independently under the same rule search uses.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Operational inbox", content: json(inboxResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/inbox/dismissals",
      description:
        "Record that the signed-in actor has seen an occurrence and is not acting on it. The " +
        "key is checked against the inbox this actor can derive now, so an item that has " +
        "already resolved — or one their role cannot read — is a 404 rather than a stored row.",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { content: json(inboxDismissalInputSchema) },
      },
      responses: {
        201: { description: "Dismissal recorded", content: json(inboxDismissalResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/events/{eventId}/inbox/dismissals/{itemKey}",
      description:
        "Undo a dismissal. Idempotent: a key that is not dismissed answers 204 as well, because " +
        "the caller asked for it to be gone and it is gone.",
      security: [{ sessionCookie: [] }],
      // Both path variables, or the template carries one a generated client cannot fill.
      request: { params: inboxDismissalParamsSchema },
      responses: {
        204: { description: "Dismissal removed" },
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
