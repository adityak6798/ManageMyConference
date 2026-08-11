/**
 * The demo-session endpoint and the session read.
 *
 * Owned by the `identity-access` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  demoSessionInputSchema,
  demoSessionResponseSchema,
  sessionResponseSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const identityPaths: OpenApiFragment = {
  domain: "identity-access",
  register(registry, { json, errorResponse }) {
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
