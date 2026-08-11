/**
 * Prospects, their owners, and the conversion that hands a prospect to the content domain as a speaker.
 *
 * Owned by the `crm` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-CRM-001
 */
import {
  createProspectInputSchema,
  eventIdParamsSchema,
  prospectListQuerySchema,
  prospectPathSchema,
  updateProspectInputSchema,
} from "@greenroom/contracts";
import {
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
} from "../../../application/crm/public";
import { requireCapability } from "../../../application/identity/actor";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/prospects",
  "POST /api/events/:eventId/prospects",
  "GET /api/events/:eventId/prospects/owners",
  "GET /api/events/:eventId/prospects/:prospectId",
  "PATCH /api/events/:eventId/prospects/:prospectId",
  "POST /api/events/:eventId/prospects/:prospectId/convert",
] as const;

export const crmRoutes: RouteModule = {
  domain: "crm",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { crm } = dependencies;
    app.get("/api/events/:eventId/prospects", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = eventIdParamsSchema.safeParse(context.req.param());
      const query = prospectListQuerySchema.safeParse(context.req.query());
      if (!path.success || !query.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Prospect filters are invalid.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json({
        prospects: await crm.list(context.get("actor"), path.data.eventId, {
          ...query.data,
          overdueBefore: query.data.overdue ? new Date().toISOString() : undefined,
        }),
      });
    });
    app.post("/api/events/:eventId/prospects", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = eventIdParamsSchema.safeParse(context.req.param());
      const input = createProspectInputSchema.safeParse(await readJson(context.req));
      if (!path.success || !input.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The prospect could not be created.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json(
        {
          prospect: await crm.create(context.get("actor"), {
            eventId: path.data.eventId,
            ...input.data,
          }),
        },
        201,
      );
    });
    // Registered before `/prospects/:prospectId` so the literal segment is not swallowed by the
    // parameterised route.
    app.get("/api/events/:eventId/prospects/owners", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = eventIdParamsSchema.safeParse(context.req.param());
      if (!path.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({
        owners: await crm.listOwners(context.get("actor"), path.data.eventId),
      });
    });
    app.get("/api/events/:eventId/prospects/:prospectId", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = prospectPathSchema.safeParse(context.req.param());
      if (!path.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Prospect identity is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json({
        prospect: await crm.get(context.get("actor"), path.data.eventId, path.data.prospectId),
      });
    });
    app.patch("/api/events/:eventId/prospects/:prospectId", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = prospectPathSchema.safeParse(context.req.param());
      const input = updateProspectInputSchema.safeParse(await readJson(context.req));
      // Named fields, because one of the ways this refuses a body is subtle: `stage-change`
      // and `conversion` are activity kinds the CRM service narrates for itself, and a client
      // that submits one is told which field it may not write rather than only that something
      // was wrong.
      if (!path.success || !input.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The prospect could not be updated.",
            context.get("correlationId"),
            input.success ? undefined : validationFields(input.error.issues),
          ),
          400,
        );
      return context.json({
        prospect: await crm.update(
          context.get("actor"),
          path.data.eventId,
          path.data.prospectId,
          input.data,
        ),
      });
    });
    app.post("/api/events/:eventId/prospects/:prospectId/convert", async (context) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = prospectPathSchema.safeParse(context.req.param());
      if (!path.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Prospect identity is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json({
        prospect: await crm.convert(
          context.get("actor"),
          path.data.eventId,
          path.data.prospectId,
          context.get("correlationId"),
        ),
      });
    });
  },
  translateError(error: unknown) {
    if (error instanceof ProspectNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof ProspectContactRequiredError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "A contact is required before conversion.",
        status: 409 as const,
      };
    if (error instanceof ProspectAlreadyConvertedError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "Converted prospects cannot be changed.",
        status: 409 as const,
      };
    if (error instanceof ProspectOwnerNotEligibleError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "Choose an owner who works on this event.",
        status: 400 as const,
        fields: error.fields,
      };
    return null;
  },
};
