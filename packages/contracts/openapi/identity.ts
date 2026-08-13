/**
 * The demo-session endpoint and the session read.
 *
 * Owned by the `identity-access` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  authConfigResponseSchema,
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventTokenRequestSchema,
  eventTokenResponseSchema,
  loginCodeRequestResponseSchema,
  loginCodeRequestSchema,
  loginCodeVerifyResponseSchema,
  loginCodeVerifySchema,
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
        "Clear this browser's session cookie. Not revocation: the session token is a signed " +
        "bearer with its own expiry and nothing server-side tracks it (issue #12).",
      responses: {
        200: { description: "Session cookie cleared", content: json(signOutResponseSchema) },
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
