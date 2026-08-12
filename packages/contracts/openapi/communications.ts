/**
 * Templates, the delivery outbox and its attempt history.
 *
 * Owned by the `communications-integrations` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  accelEventsIntegrationSchema,
  accelEventsSyncInputSchema,
  accelEventsSyncReportSchema,
  broadcastInputSchema,
  broadcastRecipientsParamsSchema,
  broadcastRecipientsResponseSchema,
  broadcastResponseSchema,
  communicationsHistoryParamsSchema,
  communicationsHistoryResponseSchema,
  createTemplateInputSchema,
  deliveryIdParamsSchema,
  deliveryResponseSchema,
  retryDeliveryInputSchema,
  templateListParamsSchema,
  templateListResponseSchema,
  templateResponseSchema,
  eventIdParamsSchema,
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
      method: "get",
      path: "/api/communications/templates",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { query: templateListParamsSchema },
      responses: {
        200: {
          description: "Every immutable template version in the organization",
          content: json(templateListResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/communications/recipients",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { query: broadcastRecipientsParamsSchema },
      responses: {
        200: {
          description: "The event's speakers, with the address each can be reached at",
          content: json(broadcastRecipientsResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/communications/broadcasts",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(broadcastInputSchema) } },
      responses: {
        202: {
          description: "One queued delivery per reachable speaker, plus who could not be reached",
          content: json(broadcastResponseSchema),
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
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/integrations/accelevents",
      description:
        "The inbound Accelevents registration integration and its last apply. `mode` says whether registrants come from the real platform or the in-repository fixture roster, because an organizer reading a count needs to know which.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "Integration state and last run",
          content: json(accelEventsIntegrationSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/integrations/accelevents/sync",
      description:
        "Preview or apply the one-way registration sync from Accelevents into Greenroom. `commit: false` is a dry run that writes nothing anywhere, including the last-run record. Applying twice converges: registrants already imported are reported as skipped rather than duplicated. Answers 502 when the registration platform cannot be read, with a normalized code and never the upstream's own message.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(accelEventsSyncInputSchema) },
      },
      responses: {
        200: {
          description: "What the sync did, or would do",
          content: json(accelEventsSyncReportSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        502: errorResponse,
        500: errorResponse,
      },
    });
  },
};
