/**
 * Prospects, their owners, and conversion.
 *
 * Owned by the `crm` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  contactDashboardResponseSchema,
  contactDirectoryParamsSchema,
  contactListQuerySchema,
  contactListResponseSchema,
  contactPathSchema,
  contactResponseSchema,
  createContactInputSchema,
  createProspectInputSchema,
  createSegmentInputSchema,
  duplicateListResponseSchema,
  eventIdParamsSchema,
  importContactsInputSchema,
  importContactsResponseSchema,
  importPreviewResponseSchema,
  mergeContactsInputSchema,
  outreachInputSchema,
  outreachPreviewResponseSchema,
  outreachResponseSchema,
  prospectListQuerySchema,
  prospectListResponseSchema,
  prospectOwnerListResponseSchema,
  prospectPathSchema,
  prospectResponseSchema,
  pushContactToEventInputSchema,
  pushContactToEventResponseSchema,
  segmentListResponseSchema,
  segmentResponseSchema,
  updateContactInputSchema,
  updateProspectInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const crmPaths: OpenApiFragment = {
  domain: "crm",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema, query: prospectListQuerySchema },
      responses: {
        200: { description: "Event prospect pipeline", content: json(prospectListResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/prospects",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(createProspectInputSchema) },
      },
      responses: {
        201: { description: "Created prospect", content: json(prospectResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects/owners",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "Users assignable as the owner of a prospect on this event",
          content: json(prospectOwnerListResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/prospects/{prospectId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: prospectPathSchema },
      responses: {
        200: {
          description: "Prospect with contacts and CRM history",
          content: json(prospectResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/events/{eventId}/prospects/{prospectId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: prospectPathSchema,
        body: { required: true, content: json(updateProspectInputSchema) },
      },
      responses: {
        200: { description: "Updated prospect", content: json(prospectResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/prospects/{prospectId}/convert",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: prospectPathSchema },
      responses: {
        200: {
          description: "Idempotently converted prospect",
          content: json(prospectResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });

    /*
     * The organization-wide directory. Addressed by organization throughout: the path shape is
     * the wire-level statement that these answers span events and are authorized once, at the
     * organization, rather than by whichever event a caller happened to name.
     */
    const refusals = {
      400: errorResponse,
      401: errorResponse,
      403: errorResponse,
      500: errorResponse,
    };
    const withMissing = { ...refusals, 404: errorResponse };
    const directory = (path: string) => `/api/organizations/{organizationId}/crm/${path}`;
    const security = [{ sessionCookie: [] }, { eventBearer: [] }];

    registry.registerPath({
      method: "get",
      path: directory("contacts"),
      security,
      request: { params: contactDirectoryParamsSchema, query: contactListQuerySchema },
      responses: {
        200: {
          description: "Contacts matching the filters, with the filters that produced them",
          content: json(contactListResponseSchema),
        },
        ...withMissing,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("contacts"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(createContactInputSchema) },
      },
      responses: {
        201: { description: "Created contact", content: json(contactResponseSchema) },
        ...refusals,
        409: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: directory("contacts/{contactId}"),
      security,
      request: { params: contactPathSchema },
      responses: {
        200: {
          description: "Contact profile with tags, custom fields, event history and timeline",
          content: json(contactResponseSchema),
        },
        ...withMissing,
      },
    });
    registry.registerPath({
      method: "patch",
      path: directory("contacts/{contactId}"),
      security,
      request: {
        params: contactPathSchema,
        body: { required: true, content: json(updateContactInputSchema) },
      },
      responses: {
        200: { description: "Updated contact", content: json(contactResponseSchema) },
        ...withMissing,
        409: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("contacts/{contactId}/events"),
      security,
      request: {
        params: contactPathSchema,
        body: { required: true, content: json(pushContactToEventInputSchema) },
      },
      responses: {
        201: {
          description: "The contact sourced into one event, with the prospect it created or reused",
          content: json(pushContactToEventResponseSchema),
        },
        ...withMissing,
        409: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: directory("duplicates"),
      security,
      request: { params: contactDirectoryParamsSchema },
      responses: {
        200: {
          description: "Near-duplicate contact groups, each with a suggested primary",
          content: json(duplicateListResponseSchema),
        },
        ...refusals,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("merges"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(mergeContactsInputSchema) },
      },
      responses: {
        200: {
          description: "The surviving contact, carrying the merged records as aliases",
          content: json(contactResponseSchema),
        },
        ...withMissing,
        409: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: directory("segments"),
      security,
      request: { params: contactDirectoryParamsSchema },
      responses: {
        200: { description: "Saved directory views", content: json(segmentListResponseSchema) },
        ...refusals,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("segments"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(createSegmentInputSchema) },
      },
      responses: {
        201: { description: "Saved view", content: json(segmentResponseSchema) },
        ...refusals,
        409: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("imports/preview"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(importContactsInputSchema) },
      },
      responses: {
        200: {
          description: "What committing this file would do, row by row",
          content: json(importPreviewResponseSchema),
        },
        ...refusals,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("imports"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(importContactsInputSchema) },
      },
      responses: {
        201: {
          description: "The committed import, the contacts it wrote, and the rows it refused",
          content: json(importContactsResponseSchema),
        },
        ...refusals,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("outreach/preview"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(outreachInputSchema) },
      },
      responses: {
        200: {
          description: "Who this outreach would reach. Writes nothing",
          content: json(outreachPreviewResponseSchema),
        },
        ...withMissing,
      },
    });
    registry.registerPath({
      method: "post",
      path: directory("outreach"),
      security,
      request: {
        params: contactDirectoryParamsSchema,
        body: { required: true, content: json(outreachInputSchema) },
      },
      responses: {
        200: {
          description: "Recipients, each with the communications delivery its send created",
          content: json(outreachResponseSchema),
        },
        ...withMissing,
      },
    });
    registry.registerPath({
      method: "get",
      path: directory("dashboard"),
      security,
      request: { params: contactDirectoryParamsSchema },
      responses: {
        200: {
          description: "Organization-level CRM metrics, counted over stored contacts",
          content: json(contactDashboardResponseSchema),
        },
        ...refusals,
      },
    });
  },
};
