/**
 * Templates, the delivery outbox, its attempt history, and the retry an organizer can trigger on a terminal delivery.
 *
 * Owned by the `communications-integrations` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-COM-001 PRD-INT-001
 */
import {
  accelEventsSyncInputSchema,
  broadcastInputSchema,
  eventIdParamsSchema,
  broadcastRecipientsParamsSchema,
  communicationsHistoryParamsSchema,
  createTemplateInputSchema,
  deliveryIdParamsSchema,
  retryDeliveryInputSchema,
  templateListParamsSchema,
  triggerDeliveryInputSchema,
  createWebhookInputSchema,
  organizationWebhookParamsSchema,
  updateWebhookInputSchema,
  webhookDeliveryParamsSchema,
  webhookHistoryParamsSchema,
  webhookIdempotencyHeaderSchema,
  webhookParamsSchema,
} from "@greenroom/contracts";
import {
  AccelEventsUnavailableError,
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
  WebhookUnavailableError,
} from "../../../application/communications/public";
import {
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../../../application/identity/actor";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "POST /api/communications/templates",
  "GET /api/communications/templates",
  "GET /api/communications/recipients",
  "POST /api/communications/broadcasts",
  "POST /api/communications/deliveries",
  "GET /api/communications/history",
  "POST /api/communications/deliveries/:deliveryId/retry",
  "GET /api/events/:eventId/integrations/accelevents",
  "POST /api/events/:eventId/integrations/accelevents/sync",
  "POST /api/organizations/:organizationId/webhooks",
  "GET /api/organizations/:organizationId/webhooks",
  "PATCH /api/organizations/:organizationId/webhooks/:subscriptionId",
  "DELETE /api/organizations/:organizationId/webhooks/:subscriptionId",
  "POST /api/organizations/:organizationId/webhooks/:subscriptionId/rotate-secret",
  "GET /api/organizations/:organizationId/webhooks/:subscriptionId/deliveries",
  "POST /api/organizations/:organizationId/webhook-deliveries/:deliveryId/replay",
] as const;

const publicSubscription = ({
  secretMaterial: _secret,
  previousSecretMaterial: _previous,
  previousSecretExpiresAt: _previousExpiry,
  revision: _revision,
  ...subscription
}: Awaited<ReturnType<NonNullable<HttpDependencies["webhooks"]>["update"]>>) => subscription;
const requireWebhookIdempotencyKey = (request: { header(name: string): string | undefined }) => {
  const parsed = webhookIdempotencyHeaderSchema.safeParse({
    "idempotency-key": request.header("Idempotency-Key"),
  });
  if (!parsed.success) throw new CommunicationsInputError("Idempotency-Key header is required");
  return parsed.data["idempotency-key"];
};

export const communicationsRoutes: RouteModule = {
  domain: "communications-integrations",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { communications, accelEventsSync, webhooks } = dependencies;
    app.post("/api/communications/templates", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = createTemplateInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The template is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json(
        { template: await communications.createTemplate(context.get("actor"), parsed.data) },
        201,
      );
    });
    app.get("/api/communications/templates", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = templateListParamsSchema.safeParse(context.req.query());
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "An organization ID is required.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        templates: await communications.templates(context.get("actor"), parsed.data.organizationId),
      });
    });
    app.get("/api/communications/recipients", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = broadcastRecipientsParamsSchema.safeParse(context.req.query());
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Organization and event IDs are required.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      // The whole result, `audienceVersion` included: the console confirms against this count
      // and sends the version back, so a send whose audience has since changed is refused.
      return context.json(
        await communications.recipients(
          context.get("actor"),
          parsed.data.organizationId,
          parsed.data.eventId,
        ),
      );
    });
    app.post("/api/communications/broadcasts", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = broadcastInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The send is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      // 202: the deliveries are durable, but nothing has been sent until the outbox drains them.
      return context.json(await communications.broadcast(context.get("actor"), parsed.data), 202);
    });
    app.post("/api/communications/deliveries", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = triggerDeliveryInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The delivery trigger is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json(
        { delivery: await communications.trigger(context.get("actor"), parsed.data) },
        202,
      );
    });
    app.get("/api/communications/history", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const parsed = communicationsHistoryParamsSchema.safeParse(context.req.query());
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Organization and event IDs are required.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json(
        await communications.history(
          context.get("actor"),
          parsed.data.organizationId,
          parsed.data.eventId,
          { limit: parsed.data.limit, cursor: parsed.data.cursor },
        ),
      );
    });
    app.post("/api/communications/deliveries/:deliveryId/retry", async (context) => {
      requireCapability(context.get("actor"), "communications:manage");
      if (!communications) throw new Error("Communications service is not configured");
      const params = deliveryIdParamsSchema.safeParse(context.req.param());
      const query = retryDeliveryInputSchema.safeParse(context.req.query());
      if (!params.success || !query.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The recovery request is invalid.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json({
        delivery: await communications.retry(
          context.get("actor"),
          query.data.organizationId,
          params.data.deliveryId,
        ),
      });
    });

    /*
     * The inbound Accelevents registration sync (#58).
     *
     * Event-scoped rather than organization-scoped because a registration platform's roster is
     * per event, and authorization is content's — `content:manage` on this event, enforced inside
     * the service by the import command it calls. The transport adds no check of its own here
     * rather than adding a second, weaker one that could drift from it.
     */
    app.get("/api/events/:eventId/integrations/accelevents", async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), parsed.data.eventId, "content:manage");
      if (!accelEventsSync) throw new Error("Accelevents integration is not configured");
      return context.json(
        await accelEventsSync.describe(context.get("actor"), parsed.data.eventId),
      );
    });
    app.post("/api/events/:eventId/integrations/accelevents/sync", async (context) => {
      // A malformed event id ends the request before anything else happens. Reading the body
      // first would spend work on a request already known to be a 400, and would leave the
      // authorization below unreachable for the very requests whose scope cannot be determined.
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      // Then denial, still before the body is read. The service authorizes too, but leaving it to
      // the service alone means an anonymous caller receives a validation error with field detail
      // instead of a 401, and has their request body read and parsed on the way to it — and this
      // domain's stated invariant is that denial happens before request-body parsing.
      requireEventCapability(context.get("actor"), params.data.eventId, "content:manage");
      const body = accelEventsSyncInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The sync request is invalid.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      if (!accelEventsSync) throw new Error("Accelevents integration is not configured");
      return context.json(
        await accelEventsSync.sync(
          context.get("actor"),
          params.data.eventId,
          { commit: body.data.commit },
          context.get("correlationId"),
        ),
      );
    });
    app.post("/api/organizations/:organizationId/webhooks", async (context) => {
      if (!webhooks) throw new WebhookUnavailableError();
      const params = organizationWebhookParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Organization ID is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      const authorized = requireCapability(context.get("actor"), "communications:manage");
      if (!authorized.organizations.some(({ id }) => id === params.data.organizationId))
        throw new CapabilityDeniedError("Organization access denied");
      const idempotencyKey = requireWebhookIdempotencyKey(context.req);
      const body = createWebhookInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The webhook subscription is invalid.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const created = await webhooks.create(
        context.get("actor"),
        {
          organizationId: params.data.organizationId,
          url: body.data.url,
          eventTypes: body.data.eventTypes,
          ...(body.data.eventId === undefined ? {} : { eventId: body.data.eventId }),
        },
        idempotencyKey,
      );
      return context.json(
        { subscription: publicSubscription(created.subscription), secret: created.secret },
        201,
      );
    });
    app.get("/api/organizations/:organizationId/webhooks", async (context) => {
      if (!webhooks) throw new WebhookUnavailableError();
      const params = organizationWebhookParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Organization ID is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json({
        subscriptions: (await webhooks.list(context.get("actor"), params.data.organizationId)).map(
          publicSubscription,
        ),
      });
    });
    app.patch("/api/organizations/:organizationId/webhooks/:subscriptionId", async (context) => {
      if (!webhooks) throw new WebhookUnavailableError();
      const params = webhookParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Webhook reference is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      const authorized = requireCapability(context.get("actor"), "communications:manage");
      if (!authorized.organizations.some(({ id }) => id === params.data.organizationId))
        throw new CapabilityDeniedError("Organization access denied");
      const idempotencyKey = requireWebhookIdempotencyKey(context.req);
      const body = updateWebhookInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The webhook update is invalid.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      return context.json({
        subscription: publicSubscription(
          await webhooks.update(
            context.get("actor"),
            params.data.organizationId,
            params.data.subscriptionId,
            {
              ...(body.data.url === undefined ? {} : { url: body.data.url }),
              ...(body.data.eventId === undefined ? {} : { eventId: body.data.eventId }),
              ...(body.data.eventTypes === undefined ? {} : { eventTypes: body.data.eventTypes }),
            },
            idempotencyKey,
          ),
        ),
      });
    });
    app.delete("/api/organizations/:organizationId/webhooks/:subscriptionId", async (context) => {
      if (!webhooks) throw new WebhookUnavailableError();
      const params = webhookParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Webhook reference is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      const authorized = requireCapability(context.get("actor"), "communications:manage");
      if (!authorized.organizations.some(({ id }) => id === params.data.organizationId))
        throw new CapabilityDeniedError("Organization access denied");
      const idempotencyKey = requireWebhookIdempotencyKey(context.req);
      await webhooks.disable(
        context.get("actor"),
        params.data.organizationId,
        params.data.subscriptionId,
        idempotencyKey,
      );
      return context.body(null, 204);
    });
    app.post(
      "/api/organizations/:organizationId/webhooks/:subscriptionId/rotate-secret",
      async (context) => {
        if (!webhooks) throw new WebhookUnavailableError();
        const params = webhookParamsSchema.safeParse(context.req.param());
        if (!params.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Webhook reference is malformed.",
              context.get("correlationId"),
            ),
            400,
          );
        const authorized = requireCapability(context.get("actor"), "communications:manage");
        if (!authorized.organizations.some(({ id }) => id === params.data.organizationId))
          throw new CapabilityDeniedError("Organization access denied");
        const idempotencyKey = requireWebhookIdempotencyKey(context.req);
        return context.json(
          await webhooks.rotate(
            context.get("actor"),
            params.data.organizationId,
            params.data.subscriptionId,
            idempotencyKey,
          ),
        );
      },
    );
    app.get(
      "/api/organizations/:organizationId/webhooks/:subscriptionId/deliveries",
      async (context) => {
        if (!webhooks) throw new WebhookUnavailableError();
        const parsed = webhookHistoryParamsSchema.safeParse({
          ...context.req.param(),
          ...context.req.query(),
        });
        if (!parsed.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Webhook history request is invalid.",
              context.get("correlationId"),
              validationFields(parsed.error.issues),
            ),
            400,
          );
        return context.json(
          await webhooks.history(
            context.get("actor"),
            parsed.data.organizationId,
            parsed.data.subscriptionId,
            {
              limit: parsed.data.limit,
              ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
            },
          ),
        );
      },
    );
    app.post(
      "/api/organizations/:organizationId/webhook-deliveries/:deliveryId/replay",
      async (context) => {
        if (!webhooks) throw new WebhookUnavailableError();
        const params = webhookDeliveryParamsSchema.safeParse(context.req.param());
        if (!params.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Webhook delivery reference is malformed.",
              context.get("correlationId"),
            ),
            400,
          );
        const authorized = requireCapability(context.get("actor"), "communications:manage");
        if (!authorized.organizations.some(({ id }) => id === params.data.organizationId))
          throw new CapabilityDeniedError("Organization access denied");
        const idempotencyKey = requireWebhookIdempotencyKey(context.req);
        return context.json({
          delivery: await webhooks.replay(
            context.get("actor"),
            params.data.organizationId,
            params.data.deliveryId,
            idempotencyKey,
          ),
        });
      },
    );
  },
  translateError(error: unknown) {
    // The registration platform being unreachable is not the organizer's mistake and not a bug
    // here, so it is a 502 rather than a 400 or a 500 — and it carries a normalized code, never
    // the provider's own message, which can echo a token back.
    if (error instanceof AccelEventsUnavailableError)
      return {
        code: "UPSTREAM_UNAVAILABLE" as const,
        message: `The Accelevents registration platform could not be read (${error.code}).`,
        status: 502 as const,
      };
    if (error instanceof CommunicationsInputError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CommunicationsNotFoundError)
      return { code: "NOT_FOUND" as const, message: error.message, status: 404 as const };
    if (error instanceof CommunicationsConflictError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof WebhookUnavailableError)
      return {
        code: "WEBHOOK_UNAVAILABLE" as const,
        message: "Webhook delivery is not configured.",
        status: 503 as const,
      };
    return null;
  },
};
