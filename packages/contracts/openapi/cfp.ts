/**
 * The organizer's form composer and the public applicant surface.
 *
 * Owned by the `cfp` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  cfpResponseSchema,
  cfpStateInputSchema,
  eventIdParamsSchema,
  proposalConfirmationResponseSchema,
  saveCfpInputSchema,
  submitProposalInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const cfpPaths: OpenApiFragment = {
  domain: "cfp",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/cfp",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Editable CFP and published state", content: json(cfpResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/cfp",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(saveCfpInputSchema) },
      },
      responses: {
        200: { description: "Saved CFP draft", content: json(cfpResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/cfp/state",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(cfpStateInputSchema) },
      },
      responses: {
        200: { description: "Updated CFP state", content: json(cfpResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/public/events/{eventId}/cfp",
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Published CFP", content: json(cfpResponseSchema) },
        400: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/public/events/{eventId}/submissions",
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(submitProposalInputSchema) },
      },
      responses: {
        201: {
          description: "Durable proposal confirmation",
          content: json(proposalConfirmationResponseSchema),
        },
        400: errorResponse,
        404: errorResponse,
        // Throttled per client address and event; the response carries `Retry-After`.
        429: errorResponse,
        500: errorResponse,
      },
    });
  },
};
