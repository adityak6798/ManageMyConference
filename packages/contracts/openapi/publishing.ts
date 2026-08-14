/**
 * The public projection, its organizer preview, and the published schedule.
 *
 * Owned by the `publishing` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  eventIdParamsSchema,
  itineraryCreatedResponseSchema,
  itineraryInputSchema,
  itineraryResponseSchema,
  itineraryTokenParamsSchema,
  publicationPreviewResponseSchema,
  publicationSettingsInputSchema,
  publicEventResponseSchema,
  publicEventSlugParamsSchema,
  publicScheduleSchema,
  publicSitePageResponseSchema,
  publicSiteResponseSchema,
  siteConsentsResponseSchema,
  siteDetailResponseSchema,
  siteDraftSchema,
  siteOrganizationParamsSchema,
  sitePageParamsSchema,
  siteParamsSchema,
  sitePrivacyNoticeInputSchema,
  sitePrivacyNoticeResponseSchema,
  siteRegistrationInputSchema,
  siteRegistrationResponseSchema,
  siteResponseSchema,
  siteRevisionInputSchema,
  sitesResponseSchema,
  siteSlugParamsSchema,
  siteUpdateSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const publishingPaths: OpenApiFragment = {
  domain: "publishing",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/public/events/{slug}",
      request: { params: publicEventSlugParamsSchema },
      responses: {
        200: {
          description: "Immutable public event snapshot",
          content: json(publicEventResponseSchema),
        },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/public/events/{slug}/schedule",
      request: { params: publicEventSlugParamsSchema },
      responses: {
        200: {
          description:
            "Sessions the published projection places, under the agenda publication in force",
          content: json(z.object({ schedule: publicScheduleSchema })),
        },
        404: errorResponse,
        500: errorResponse,
      },
    });
    // The three organizer actions differ only in verb and description, so they are declared
    // once rather than copied three times.
    for (const action of ["preview", "publish", "unpublish"] as const)
      registry.registerPath({
        method: action === "preview" ? "get" : "post",
        path: `/api/publishing/events/{eventId}/${action}`,
        security: [{ sessionCookie: [] }, { eventBearer: [] }],
        request: { params: eventIdParamsSchema },
        responses: {
          200: {
            description: `Publication ${action}`,
            content: json(publicationPreviewResponseSchema),
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      });
    /*
     * Attendee itineraries. No security scheme, and that is the design rather than an
     * omission: the token in the path is the whole of the authorization, because the
     * namespace's `Access-Control-Allow-Origin: *` policy forbids credentials.
     */
    registry.registerPath({
      method: "post",
      path: "/api/public/events/{slug}/itinerary",
      request: {
        params: publicEventSlugParamsSchema,
        body: { required: true, content: json(itineraryInputSchema) },
      },
      responses: {
        201: {
          description: "A new itinerary, and the only response that carries its token",
          content: json(itineraryCreatedResponseSchema),
        },
        400: errorResponse,
        404: errorResponse,
        429: errorResponse,
        500: errorResponse,
      },
    });
    for (const method of ["get", "post"] as const)
      registry.registerPath({
        method,
        path: "/api/public/itineraries/{token}",
        request: {
          params: itineraryTokenParamsSchema,
          ...(method === "post"
            ? { body: { required: true, content: json(itineraryInputSchema) } }
            : {}),
        },
        responses: {
          200: {
            description: method === "get" ? "The stored itinerary" : "The saved itinerary",
            content: json(itineraryResponseSchema),
          },
          ...(method === "post" ? { 400: errorResponse } : {}),
          404: errorResponse,
          500: errorResponse,
        },
      });
    registry.registerPath({
      method: "patch",
      path: "/api/publishing/events/{eventId}/settings",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(publicationSettingsInputSchema) },
      },
      responses: {
        200: {
          description: "Public details saved to the draft; the published snapshot is untouched",
          content: json(publicationPreviewResponseSchema),
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
     * Sites and portals (issue #196). The public half lives under its own prefix, so a Site's
     * address and an event's address never need to reserve against each other.
     */
    registry.registerPath({
      method: "get",
      path: "/api/public/sites/{slug}",
      description:
        "The published portal at this address: its landing copy, its programs in order, its " +
        "pages, its registration form and the privacy notice in force. A draft, an unpublished " +
        "site and an unknown address are one answer.",
      request: { params: siteSlugParamsSchema },
      responses: {
        200: { description: "Published portal", content: json(publicSiteResponseSchema) },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/public/sites/{slug}/pages/{pageSlug}",
      description:
        "One published page. A hidden page is not found rather than forbidden, so the route " +
        "cannot be used to discover pages that are not for visitors.",
      request: { params: sitePageParamsSchema },
      responses: {
        200: { description: "Portal page", content: json(publicSitePageResponseSchema) },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/public/sites/{slug}/registrations",
      description:
        "Register against the portal. The privacy-notice version is stamped by the server from " +
        "the notice in force, never taken from the request: a client that could supply it could " +
        "claim consent to a version the visitor never saw. Throttled by caller address.",
      request: {
        params: siteSlugParamsSchema,
        body: { required: true, content: json(siteRegistrationInputSchema) },
      },
      responses: {
        201: { description: "Registered", content: json(siteRegistrationResponseSchema) },
        400: errorResponse,
        404: errorResponse,
        409: errorResponse,
        429: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/publishing/organizations/{organizationId}/sites",
      security: [{ sessionCookie: [] }],
      request: { params: siteOrganizationParamsSchema },
      responses: {
        200: { description: "Sites in this organization", content: json(sitesResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/publishing/organizations/{organizationId}/sites",
      security: [{ sessionCookie: [] }],
      description: "Compose a portal. Created as a draft; publishing is a separate action.",
      request: {
        params: siteOrganizationParamsSchema,
        body: { required: true, content: json(siteDraftSchema) },
      },
      responses: {
        201: { description: "Site created", content: json(siteResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/publishing/organizations/{organizationId}/sites/{siteId}",
      security: [{ sessionCookie: [] }],
      description:
        "The organizer's view: the draft, which attached programs no longer resolve, and the " +
        "publish history.",
      request: { params: siteParamsSchema },
      responses: {
        200: { description: "Site", content: json(siteDetailResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/publishing/organizations/{organizationId}/sites/{siteId}",
      security: [{ sessionCookie: [] }],
      description:
        "Rewrite the draft at an expected revision. Page markup is sanitized before it is " +
        "stored, so what a client sends is never what is served.",
      request: {
        params: siteParamsSchema,
        body: { required: true, content: json(siteUpdateSchema) },
      },
      responses: {
        200: { description: "Site saved", content: json(siteResponseSchema) },
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
      path: "/api/publishing/organizations/{organizationId}/sites/{siteId}/privacy-notice",
      security: [{ sessionCookie: [] }],
      description:
        "Append a privacy-notice version. Append, never rewrite: every stored consent names the " +
        "version it accepted, and a version whose text could move would make those records " +
        "claims about words nobody can produce.",
      request: {
        params: siteParamsSchema,
        body: { required: true, content: json(sitePrivacyNoticeInputSchema) },
      },
      responses: {
        201: {
          description: "Notice version published",
          content: json(sitePrivacyNoticeResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    for (const action of ["publish", "unpublish"] as const)
      registry.registerPath({
        method: "post",
        path: `/api/publishing/organizations/{organizationId}/sites/{siteId}/${action}`,
        security: [{ sessionCookie: [] }],
        description:
          action === "publish"
            ? "Take the portal live at an expected revision, appending an immutable snapshot to " +
              "the publish history. Refused until a privacy notice exists, because registration " +
              "records the version somebody accepted."
            : "Withdraw the portal. The address stops answering and the history stays; there is " +
              "no delete for a Site.",
        request: {
          params: siteParamsSchema,
          body: { required: true, content: json(siteRevisionInputSchema) },
        },
        responses: {
          200: { description: "Publication state changed", content: json(siteResponseSchema) },
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
      path: "/api/publishing/organizations/{organizationId}/sites/{siteId}/consents",
      security: [{ sessionCookie: [] }],
      description:
        "Who registered and which notice version they accepted. Organizer-only, and never on a " +
        "public route.",
      request: { params: siteParamsSchema },
      responses: {
        200: { description: "Consent records", content: json(siteConsentsResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
  },
};
