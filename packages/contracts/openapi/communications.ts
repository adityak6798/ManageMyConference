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
  createWebhookInputSchema,
  createWebhookResponseSchema,
  organizationWebhookParamsSchema,
  rotateWebhookResponseSchema,
  schedulePublishedWebhookPayloadSchema,
  updateWebhookInputSchema,
  webhookDeliveryParamsSchema,
  webhookDeliveryResponseSchema,
  webhookHistoryParamsSchema,
  webhookHistoryResponseSchema,
  webhookIdempotencyHeaderSchema,
  webhookParamsSchema,
  webhookPayloadSchema,
  webhookResponseSchema,
  webhooksResponseSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const communicationsPaths: OpenApiFragment = {
  domain: "communications-integrations",
  register(registry, { json, errorResponse }) {
    registry.register("WebhookPayloadV1", webhookPayloadSchema);
    registry.register("SchedulePublishedWebhookPayloadV1", schedulePublishedWebhookPayloadSchema);
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
    const webhookDescription =
      "Outbound bodies use the registered WebhookPayloadV1 components. Delivery is signed with Greenroom-Signature over the exact body bytes; rotation emits both current and previous v1 signatures for 24 hours.";
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/webhooks",
      description: webhookDescription,
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: organizationWebhookParamsSchema,
        headers: webhookIdempotencyHeaderSchema,
        body: { required: true, content: json(createWebhookInputSchema) },
      },
      responses: {
        201: {
          description: "Subscription and its one-time secret",
          content: json(createWebhookResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/webhooks",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: organizationWebhookParamsSchema },
      responses: {
        200: {
          description: "Webhook subscriptions without secrets",
          content: json(webhooksResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/organizations/{organizationId}/webhooks/{subscriptionId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: webhookParamsSchema,
        headers: webhookIdempotencyHeaderSchema,
        body: { required: true, content: json(updateWebhookInputSchema) },
      },
      responses: {
        200: { description: "Updated webhook subscription", content: json(webhookResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/organizations/{organizationId}/webhooks/{subscriptionId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: webhookParamsSchema, headers: webhookIdempotencyHeaderSchema },
      responses: {
        204: { description: "Webhook disabled" },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/webhooks/{subscriptionId}/rotate-secret",
      description:
        "Returns the new secret once. Deliveries carry signatures for both secrets during the 24-hour overlap.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: webhookParamsSchema, headers: webhookIdempotencyHeaderSchema },
      responses: {
        200: {
          description: "One-time replacement secret",
          content: json(rotateWebhookResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/webhooks/{subscriptionId}/deliveries",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: webhookParamsSchema,
        query: webhookHistoryParamsSchema.omit({ organizationId: true, subscriptionId: true }),
      },
      responses: {
        200: {
          description: "Keyset-paginated immutable webhook attempts",
          content: json(webhookHistoryResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        503: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/webhook-deliveries/{deliveryId}/replay",
      description:
        "Queues the delivery again and appends an attempt naming the requesting actor; prior history is never changed.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: webhookDeliveryParamsSchema, headers: webhookIdempotencyHeaderSchema },
      responses: {
        200: {
          description: "Requeued webhook delivery",
          content: json(webhookDeliveryResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        503: errorResponse,
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
