/**
 * Prospects, their owners, and the conversion that hands a prospect to the content domain as a speaker.
 *
 * Owned by the `crm` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-CRM-001
 */
import type { Context } from "hono";
import {
  contactDirectoryParamsSchema,
  contactFiltersSchema,
  contactListQuerySchema,
  contactPathSchema,
  createContactInputSchema,
  createProspectInputSchema,
  createSegmentInputSchema,
  eventIdParamsSchema,
  importContactsInputSchema,
  mergeContactsInputSchema,
  outreachInputSchema,
  prospectListQuerySchema,
  prospectPathSchema,
  pushContactToEventInputSchema,
  updateContactInputSchema,
  updateProspectInputSchema,
} from "@greenroom/contracts";
import {
  ContactAlreadySourcedError,
  ContactEmailTakenError,
  ContactImportInvalidError,
  ContactMergeInvalidError,
  ContactNotFoundError,
  EventOutsideOrganizationError,
  OutreachRecipientsEmptyError,
  OutreachRejectedError,
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
  SegmentNameTakenError,
  SegmentNotFoundError,
} from "../../../application/crm/public";
import { requireCapability } from "../../../application/identity/actor";
import { envelope, validationFields, readJson, type Variables } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

/** The request context the directory handlers share, named once rather than re-derived. */
type CrmContext = Context<{ Variables: Variables }>;

const routes = [
  "GET /api/events/:eventId/prospects",
  "POST /api/events/:eventId/prospects",
  "GET /api/events/:eventId/prospects/owners",
  "GET /api/events/:eventId/prospects/:prospectId",
  "PATCH /api/events/:eventId/prospects/:prospectId",
  "POST /api/events/:eventId/prospects/:prospectId/convert",
  // The directory is addressed by organization, never by event. An event-scoped path could not
  // carry a cross-event answer, and this way a caller cannot reach it by naming one event.
  "GET /api/organizations/:organizationId/crm/contacts",
  "POST /api/organizations/:organizationId/crm/contacts",
  "GET /api/organizations/:organizationId/crm/contacts/:contactId",
  "PATCH /api/organizations/:organizationId/crm/contacts/:contactId",
  "POST /api/organizations/:organizationId/crm/contacts/:contactId/events",
  "GET /api/organizations/:organizationId/crm/duplicates",
  "POST /api/organizations/:organizationId/crm/merges",
  "GET /api/organizations/:organizationId/crm/segments",
  "POST /api/organizations/:organizationId/crm/segments",
  "POST /api/organizations/:organizationId/crm/imports/preview",
  "POST /api/organizations/:organizationId/crm/imports",
  "POST /api/organizations/:organizationId/crm/outreach/preview",
  "POST /api/organizations/:organizationId/crm/outreach",
  "GET /api/organizations/:organizationId/crm/dashboard",
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

    /* The organization-wide directory. */

    /**
     * Every directory handler resolves the same three things, and refuses in the same order:
     * the service must be wired, the actor must hold `crm:manage` at all, and the path must
     * name a well-formed organization. Authorization proper — membership of *this*
     * organization, and that the capability was earned inside it — belongs to the service,
     * because a route cannot answer it without reading the events domain.
     */
    const directory = (context: CrmContext) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      const path = contactDirectoryParamsSchema.safeParse(context.req.param());
      // The service is handed back rather than read from the closure so its presence is a fact
      // the type system carries into each handler instead of being re-asserted in every one.
      return {
        service: crm,
        actor: context.get("actor"),
        organizationId: path.data?.organizationId,
      };
    };
    const contactRoute = (context: CrmContext) => {
      requireCapability(context.get("actor"), "crm:manage");
      if (!crm) throw new Error("CRM service is not configured");
      return {
        service: crm,
        actor: context.get("actor"),
        path: contactPathSchema.safeParse(context.req.param()),
      };
    };
    const malformed = (context: CrmContext, message: string) =>
      context.json(
        envelope("VALIDATION_FAILED", message, context.get("correlationId")),
        400 as const,
      );

    app.get("/api/organizations/:organizationId/crm/contacts", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const query = contactListQuerySchema.safeParse(context.req.query());
      if (!organizationId || !query.success)
        return malformed(context, "Directory filters are invalid.");
      const { tags, segmentId, ...rest } = query.data;
      /*
       * The split list is re-validated rather than trusted. `contactListQuerySchema` bounds the
       * raw parameter as one string, which a caller can fill with far more than the twenty tags
       * `contactFiltersSchema` permits — and every tag becomes a bound SQL variable, so an
       * unbounded list reached D1's variable limit as a 500 rather than a refusal. The echoed
       * filters also travel back inside the response contract, which declares the same bound.
       */
      const filters = contactFiltersSchema.safeParse({
        ...rest,
        ...(tags
          ? {
              tags: tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            }
          : {}),
      });
      if (!filters.success) return malformed(context, "Directory filters are invalid.");
      return context.json(
        await service.listContacts(actor, organizationId, {
          ...filters.data,
          ...(segmentId ? { segmentId } : {}),
        }),
      );
    });

    app.post("/api/organizations/:organizationId/crm/contacts", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = createContactInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The contact could not be created.",
            context.get("correlationId"),
            input.success ? undefined : validationFields(input.error.issues),
          ),
          400,
        );
      return context.json(
        { contact: await service.createContact(actor, organizationId, input.data) },
        201,
      );
    });

    // Registered before the parameterised contact route would swallow them.
    app.get("/api/organizations/:organizationId/crm/duplicates", async (context) => {
      const { service, actor, organizationId } = directory(context);
      if (!organizationId) return malformed(context, "Organization ID is malformed.");
      return context.json({ groups: await service.duplicates(actor, organizationId) });
    });

    app.get("/api/organizations/:organizationId/crm/segments", async (context) => {
      const { service, actor, organizationId } = directory(context);
      if (!organizationId) return malformed(context, "Organization ID is malformed.");
      return context.json({ segments: await service.listSegments(actor, organizationId) });
    });

    app.post("/api/organizations/:organizationId/crm/segments", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = createSegmentInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The segment could not be saved.",
            context.get("correlationId"),
            input.success ? undefined : validationFields(input.error.issues),
          ),
          400,
        );
      return context.json(
        { segment: await service.createSegment(actor, organizationId, input.data) },
        201,
      );
    });

    app.get("/api/organizations/:organizationId/crm/dashboard", async (context) => {
      const { service, actor, organizationId } = directory(context);
      if (!organizationId) return malformed(context, "Organization ID is malformed.");
      return context.json(await service.dashboard(actor, organizationId));
    });

    app.post("/api/organizations/:organizationId/crm/merges", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = mergeContactsInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return malformed(context, "The merge could not be read.");
      return context.json({
        contact: await service.mergeContacts(actor, organizationId, input.data),
      });
    });

    app.post("/api/organizations/:organizationId/crm/imports/preview", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = importContactsInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return malformed(context, "The contact file could not be read.");
      return context.json(await service.previewImport(actor, organizationId, input.data));
    });

    app.post("/api/organizations/:organizationId/crm/imports", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = importContactsInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return malformed(context, "The contact file could not be read.");
      const result = await service.importContacts(actor, organizationId, input.data);
      return context.json(
        { import: result.record, contacts: result.contacts, rejected: result.rejected },
        201,
      );
    });

    app.post("/api/organizations/:organizationId/crm/outreach/preview", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = outreachInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return malformed(context, "The outreach request could not be read.");
      return context.json(await service.previewOutreach(actor, organizationId, input.data));
    });

    app.post("/api/organizations/:organizationId/crm/outreach", async (context) => {
      const { service, actor, organizationId } = directory(context);
      const input = outreachInputSchema.safeParse(await readJson(context.req));
      if (!organizationId || !input.success)
        return malformed(context, "The outreach request could not be read.");
      return context.json(await service.sendOutreach(actor, organizationId, input.data));
    });

    app.get("/api/organizations/:organizationId/crm/contacts/:contactId", async (context) => {
      const { service, actor, path } = contactRoute(context);
      if (!path.success) return malformed(context, "Contact identity is malformed.");
      return context.json({
        contact: await service.getContact(actor, path.data.organizationId, path.data.contactId),
      });
    });

    app.patch("/api/organizations/:organizationId/crm/contacts/:contactId", async (context) => {
      const { service, actor, path } = contactRoute(context);
      const input = updateContactInputSchema.safeParse(await readJson(context.req));
      if (!path.success || !input.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The contact could not be updated.",
            context.get("correlationId"),
            input.success ? undefined : validationFields(input.error.issues),
          ),
          400,
        );
      return context.json({
        contact: await service.updateContact(
          actor,
          path.data.organizationId,
          path.data.contactId,
          input.data,
        ),
      });
    });

    app.post(
      "/api/organizations/:organizationId/crm/contacts/:contactId/events",
      async (context) => {
        const { service, actor, path } = contactRoute(context);
        const input = pushContactToEventInputSchema.safeParse(await readJson(context.req));
        if (!path.success || !input.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "The contact could not be sourced into that event.",
              context.get("correlationId"),
              input.success ? undefined : validationFields(input.error.issues),
            ),
            400,
          );
        return context.json(
          await service.pushContactToEvent(
            actor,
            path.data.organizationId,
            path.data.contactId,
            input.data,
            context.get("correlationId"),
          ),
          201,
        );
      },
    );
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
    if (error instanceof ContactNotFoundError || error instanceof SegmentNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof ContactEmailTakenError || error instanceof SegmentNameTakenError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
        fields: error.fields,
      };
    if (error instanceof ContactMergeInvalidError || error instanceof ContactAlreadySourcedError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof ContactImportInvalidError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "The contact file could not be read.",
        status: 400 as const,
        fields: error.fields,
      };
    if (error instanceof OutreachRecipientsEmptyError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "This outreach would reach nobody.",
        status: 400 as const,
      };
    // The dispatcher's refusal, already converted to a CRM error by the adapter that binds the
    // port. A human pressed Send and is looking at the result, so it is reported rather than
    // logged and swallowed.
    if (error instanceof OutreachRejectedError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
      };
    // Not a 404: the caller may legitimately know both the organization and the event, and the
    // refusal is precisely that the two do not belong together.
    if (error instanceof EventOutsideOrganizationError)
      return {
        code: "FORBIDDEN" as const,
        message: "That event is not part of this organization.",
        status: 403 as const,
      };
    return null;
  },
};
