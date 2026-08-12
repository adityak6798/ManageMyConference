/**
 * Templates, the delivery outbox and its attempt history.
 *
 * Owned by the `communications-integrations` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  communicationsHistoryParamsSchema,
  communicationsHistoryResponseSchema,
  createTemplateInputSchema,
  deliveryIdParamsSchema,
  deliveryResponseSchema,
  retryDeliveryInputSchema,
  templateResponseSchema,
  triggerDeliveryInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const communicationsPaths: OpenApiFragment = {
  domain: "communications-integrations",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "post",
      path: "/api/communications/templates",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(createTemplateInputSchema) } },
      responses: {
        201: { description: "Immutable template version", content: json(templateResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/communications/deliveries",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(triggerDeliveryInputSchema) } },
      responses: {
        202: { description: "Queued or existing delivery", content: json(deliveryResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/communications/history",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { query: communicationsHistoryParamsSchema },
      responses: {
        200: {
          description: "Auditable delivery history",
          content: json(communicationsHistoryResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/communications/deliveries/{deliveryId}/retry",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: deliveryIdParamsSchema,
        query: retryDeliveryInputSchema,
      },
      responses: {
        200: { description: "Explicitly requeued delivery", content: json(deliveryResponseSchema) },
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
