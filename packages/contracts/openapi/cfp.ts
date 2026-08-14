/**
 * The organizer's form composer and the public applicant surface.
 *
 * Owned by the `cfp` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  cfpProposalParamsSchema,
  cfpResponseSchema,
  cfpRoutingStatusesResponseSchema,
  cfpStateInputSchema,
  cfpWindowInputSchema,
  createProposalDraftInputSchema,
  eventIdParamsSchema,
  proposalConfirmationResponseSchema,
  saveCfpInputSchema,
  saveProposalInputSchema,
  submitProposalInputSchema,
  submitterProposalResponseSchema,
  submitterProposalsResponseSchema,
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
      method: "get",
      path: "/api/events/{eventId}/cfp/routing-statuses",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "Configured CFP triage routing destinations",
          content: json(cfpRoutingStatusesResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
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
        409: errorResponse,
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
      method: "put",
      path: "/api/events/{eventId}/cfp/window",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(cfpWindowInputSchema) },
      },
      responses: {
        200: {
          description: "Scheduled submission window, applied without republishing the form",
          content: json(cfpResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    /*
     * The five submitter routes take a session cookie and **not** `eventBearer`.
     *
     * Every other event-addressed route accepts both, because both resolve to an actor whose event
     * capability is then checked. These are authorized by ownership of a row instead, so an
     * event-scoped token's one restriction — the event it was minted for — is never consulted, and
     * an API-client credential has no user to own anything. The transport refuses `bearer` on all
     * five; this is the contract saying so rather than leaving a caller to discover it.
     */
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/cfp/proposals",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: {
          description: "The signed-in submitter's own drafts and submitted proposals",
          content: json(submitterProposalsResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A bearer credential — an event token or an API client — is refused here.
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/cfp/proposals",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(createProposalDraftInputSchema) },
      },
      responses: {
        201: {
          description: "A draft bound to the signed-in submitter",
          content: json(submitterProposalResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A bearer credential — an event token or an API client — is refused here.
        403: errorResponse,
        404: errorResponse,
        // The call is closed, not yet open, or past its deadline.
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/cfp/proposals/{proposalId}",
      security: [{ sessionCookie: [] }],
      request: { params: cfpProposalParamsSchema },
      responses: {
        200: {
          description: "One proposal the signed-in submitter owns",
          content: json(submitterProposalResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A bearer credential — an event token or an API client — is refused here.
        403: errorResponse,
        // Also the answer for a proposal belonging to somebody else: the two are
        // indistinguishable so proposal ids cannot be enumerated.
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/events/{eventId}/cfp/proposals/{proposalId}",
      security: [{ sessionCookie: [] }],
      request: {
        params: cfpProposalParamsSchema,
        body: { required: true, content: json(saveProposalInputSchema) },
      },
      responses: {
        200: {
          description: "The revised proposal",
          content: json(submitterProposalResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A bearer credential — an event token or an API client — is refused here.
        403: errorResponse,
        404: errorResponse,
        // Three conflicts, one code: a stale `expectedRevision`, a call that closed before the
        // write landed, or a proposal that has since been submitted and so is no longer the thing
        // this write describes.
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/cfp/proposals/{proposalId}/submit",
      security: [{ sessionCookie: [] }],
      request: {
        params: cfpProposalParamsSchema,
        body: { required: true, content: json(saveProposalInputSchema) },
      },
      responses: {
        200: {
          description: "The submitted proposal",
          content: json(submitterProposalResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        // A bearer credential — an event token or an API client — is refused here.
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
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
