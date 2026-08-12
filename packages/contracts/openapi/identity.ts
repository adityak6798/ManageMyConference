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
      path: "/api/session",
      security: [{ sessionCookie: [] }],
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
