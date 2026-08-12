/**
 * Templates, the delivery outbox, its attempt history, and the retry an organizer can trigger on a terminal delivery.
 *
 * Owned by the `communications-integrations` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-COM-001 PRD-INT-001
 */
import {
  broadcastInputSchema,
  broadcastRecipientsParamsSchema,
  communicationsHistoryParamsSchema,
  createTemplateInputSchema,
  deliveryIdParamsSchema,
  retryDeliveryInputSchema,
  templateListParamsSchema,
  triggerDeliveryInputSchema,
} from "@greenroom/contracts";
import {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
} from "../../../application/communications/public";
import { requireCapability } from "../../../application/identity/actor";
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
] as const;

export const communicationsRoutes: RouteModule = {
  domain: "communications-integrations",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { communications } = dependencies;
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
      return context.json({
        recipients: await communications.recipients(
          context.get("actor"),
          parsed.data.organizationId,
          parsed.data.eventId,
        ),
      });
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
  },
  translateError(error: unknown) {
    if (error instanceof CommunicationsInputError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CommunicationsNotFoundError)
      return { code: "NOT_FOUND" as const, message: error.message, status: 404 as const };
    if (error instanceof CommunicationsConflictError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    return null;
  },
};
