/**
 * The demo-session endpoint and the session read.
 *
 * Owned by the `identity-access` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  acceptInvitationResponseSchema,
  acceptInvitationSchema,
  apiClientsResponseSchema,
  apiClientOrganizationParamsSchema,
  apiClientParamsSchema,
  auditEventsResponseSchema,
  authConfigResponseSchema,
  createApiClientResponseSchema,
  createApiClientSchema,
  createInvitationResponseSchema,
  createInvitationSchema,
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventRoleSchema,
  eventTokenRequestSchema,
  eventTokenResponseSchema,
  googleCallbackQuerySchema,
  loginCodeRequestResponseSchema,
  loginCodeRequestSchema,
  loginCodeVerifyResponseSchema,
  loginCodeVerifySchema,
  membershipChangeResponseSchema,
  organizationMembersResponseSchema,
  revokeAllSessionsResponseSchema,
  rotateApiClientResponseSchema,
  sessionResponseSchema,
  signOutResponseSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const identityPaths: OpenApiFragment = {
  domain: "identity-access",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/api/auth/config",
      responses: {
        200: { description: "Active identity mode", content: json(authConfigResponseSchema) },
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/auth/code",
      request: { body: { required: true, content: json(loginCodeRequestSchema) } },
      responses: {
        202: {
          description: "Login challenge created",
          content: json(loginCodeRequestResponseSchema),
        },
        400: errorResponse,
        429: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/auth/verify",
      request: { body: { required: true, content: json(loginCodeVerifySchema) } },
      responses: {
        200: {
          description: "Signed session established",
          content: json(loginCodeVerifyResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/auth/tokens",
      security: [{ sessionCookie: [] }],
      request: { body: { required: true, content: json(eventTokenRequestSchema) } },
      responses: {
        201: { description: "Event-scoped bearer token", content: json(eventTokenResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/auth/google/start",
      description:
        "Begin Google sign-in. Answers 302 to Google's authorization endpoint with a per-attempt " +
        "state and an S256 PKCE challenge, and sets a short-lived attempt cookie. 404 when this " +
        "deployment carries no Google configuration.",
      responses: {
        302: { description: "Redirect to Google's authorization endpoint" },
        404: errorResponse,
        429: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/auth/google/callback",
      request: { query: googleCallbackQuerySchema },
      description:
        "Google's return leg. Verifies the attempt, the state, and the id_token's signature, " +
        "issuer, audience, expiry and nonce, then establishes a session and redirects. Every " +
        "refusal redirects to the same destination and reports nothing about which check failed. " +
        "The redirect URI is fixed server-side and is never read from a request parameter.",
      responses: {
        302: { description: "Signed session established, or sign-in refused" },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/auth/signout",
      description:
        "Revoke this browser's session and clear its cookie. The session record is marked " +
        "revoked first, so a copy of the cookie taken elsewhere — and any event bearer token " +
        "minted from that session — stops being accepted. Answers 200 whether or not a session " +
        "was present, and reports no count, so it cannot report whether the caller held one.",
      responses: {
        200: {
          description: "Session revoked and cookie cleared",
          content: json(signOutResponseSchema),
        },
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/auth/sessions/revoke-all",
      security: [{ sessionCookie: [] }],
      description:
        "End every session belonging to the authenticated user, including this one. Requires a " +
        "real user session: a demo persona cookie is refused. 404 where the deployment records " +
        "no sessions.",
      responses: {
        200: {
          description: "Live sessions revoked",
          content: json(revokeAllSessionsResponseSchema),
        },
        401: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    /*
     * Membership administration. Addressed by organization, because that is the scope the answer
     * spans and because it gives cross-event visibility exactly one place to be authorized.
     */
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/members",
      security: [{ sessionCookie: [] }],
      description:
        "Members of the organization, each with the roles they hold on its events, plus every " +
        "invitation ever issued for it. Outstanding invitations never carry their token.",
      responses: {
        200: {
          description: "Members and invitations",
          content: json(organizationMembersResponseSchema),
        },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/invitations",
      security: [{ sessionCookie: [] }],
      description:
        "Invite an address into the organization, or onto one of its events. The response " +
        "carries the acceptance token, which is the only time it exists outside this request: " +
        "the database stores only its digest, so it cannot be reissued.",
      request: { body: { required: true, content: json(createInvitationSchema) } },
      responses: {
        201: { description: "Invitation created", content: json(createInvitationResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/organizations/{organizationId}/invitations/{invitationId}",
      security: [{ sessionCookie: [] }],
      description: "Withdraw an invitation that has not been accepted.",
      responses: {
        200: { description: "Rows changed", content: json(membershipChangeResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/invitations/accept",
      security: [{ sessionCookie: [] }],
      description:
        "Accept an invitation as the authenticated caller. The token says which invitation and " +
        "the session says who: membership is granted to the calling identity and never to the " +
        "address the invitation names. Requires a real user session, so a demo persona is " +
        "refused. An unknown, expired, revoked or already-accepted token are one 404.",
      request: { body: { required: true, content: json(acceptInvitationSchema) } },
      responses: {
        200: { description: "Invitation accepted", content: json(acceptInvitationResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/organizations/{organizationId}/members/{userId}",
      security: [{ sessionCookie: [] }],
      description:
        "Remove somebody from the organization and from every role on its events. Takes effect " +
        "on their next request; sessions are not revoked, because they may hold memberships " +
        "elsewhere.",
      responses: {
        200: { description: "Rows changed", content: json(membershipChangeResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    for (const method of ["put", "delete"] as const)
      registry.registerPath({
        method,
        path: "/api/organizations/{organizationId}/events/{eventId}/roles/{userId}",
        security: [{ sessionCookie: [] }],
        description:
          method === "put"
            ? "Grant one role on one event to a member of the owning organization."
            : "Revoke one role on one event.",
        request: { body: { required: true, content: json(eventRoleSchema) } },
        responses: {
          200: { description: "Rows changed", content: json(membershipChangeResponseSchema) },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      });
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/audit-events",
      security: [{ sessionCookie: [] }],
      description:
        "This organization's identity audit log, newest first. Rows that name no organization " +
        "are deployment-level and are not returned here.",
      responses: {
        200: { description: "Audit rows", content: json(auditEventsResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/api-clients",
      security: [{ sessionCookie: [] }],
      description:
        "Create an organization-scoped machine credential. Requires a real organizer session; " +
        "an API client cannot mint another client. The plaintext credential is returned once.",
      request: {
        params: apiClientOrganizationParamsSchema,
        body: { required: true, content: json(createApiClientSchema) },
      },
      responses: {
        201: { description: "API client created", content: json(createApiClientResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/organizations/{organizationId}/api-clients",
      security: [{ sessionCookie: [] }],
      description: "List API clients without current, previous, or hashed secrets.",
      request: { params: apiClientOrganizationParamsSchema },
      responses: {
        200: { description: "API clients", content: json(apiClientsResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/organizations/{organizationId}/api-clients/{clientId}/rotate",
      security: [{ sessionCookie: [] }],
      description:
        "Replace the credential and return it once. The previous credential remains valid for " +
        "24 hours so a running integration can move without downtime.",
      request: { params: apiClientParamsSchema },
      responses: {
        200: {
          description: "Credential rotated",
          content: json(rotateApiClientResponseSchema),
        },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/organizations/{organizationId}/api-clients/{clientId}",
      security: [{ sessionCookie: [] }],
      description:
        "Revoke a client. Revocation takes effect on its next request, and replaying the " +
        "operation converges on the same revoked state.",
      request: { params: apiClientParamsSchema },
      responses: {
        204: { description: "API client revoked" },
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/session",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      responses: {
        200: {
          description: "Current identity and capabilities",
          content: json(sessionResponseSchema),
        },
        401: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/demo-session",
      description:
        "Internal demo-only endpoint; unavailable unless DEMO_MODE is explicitly enabled.",
      request: { body: { required: true, content: json(demoSessionInputSchema) } },
      responses: {
        200: {
          description: "Signed demo session established",
          content: json(demoSessionResponseSchema),
        },
        400: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
  },
};
