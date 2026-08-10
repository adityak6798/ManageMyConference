import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import {
  apiErrorEnvelopeSchema,
  createEventInputSchema,
  createEventResponseSchema,
  createProspectInputSchema,
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventListResponseSchema,
  eventIdParamsSchema,
  healthResponseSchema,
  prospectListQuerySchema,
  prospectListResponseSchema,
  prospectPathSchema,
  prospectResponseSchema,
  sessionResponseSchema,
  updateProspectInputSchema,
} from "../src/index";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();
const json = (schema: ZodType) => ({ "application/json": { schema } });
const errorResponse = {
  description: "Standard error envelope",
  content: json(apiErrorEnvelopeSchema),
};
registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "greenroom_session",
});
registry.registerPath({
  method: "get",
  path: "/api/session",
  security: [{ sessionCookie: [] }],
  responses: {
    200: { description: "Current identity and capabilities", content: json(sessionResponseSchema) },
    401: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/health",
  responses: {
    200: { description: "Runtime readiness", content: json(healthResponseSchema) },
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/demo-session",
  description: "Internal demo-only endpoint; unavailable unless DEMO_MODE is explicitly enabled.",
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
registry.registerPath({
  method: "get",
  path: "/api/events/{eventId}",
  security: [{ sessionCookie: [] }],
  request: { params: eventIdParamsSchema },
  responses: {
    200: {
      description: "Event identity and basic metadata",
      content: json(createEventResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/events",
  security: [{ sessionCookie: [] }],
  responses: {
    200: { description: "Events", content: json(eventListResponseSchema) },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(createEventInputSchema) } },
  responses: {
    201: { description: "Created event", content: json(createEventResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/events/{eventId}/prospects",
  security: [{ sessionCookie: [] }],
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
  security: [{ sessionCookie: [] }],
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
  path: "/api/events/{eventId}/prospects/{prospectId}",
  security: [{ sessionCookie: [] }],
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
  security: [{ sessionCookie: [] }],
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
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/prospects/{prospectId}/convert",
  security: [{ sessionCookie: [] }],
  request: { params: prospectPathSchema },
  responses: {
    200: { description: "Idempotently converted prospect", content: json(prospectResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
});

const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: "3.0.3",
  info: { title: "Project Greenroom API", version: "0.1.0" },
});
const output = `${JSON.stringify(document, null, 2)}\n`;
const artifact = fileURLToPath(new URL("../openapi.json", import.meta.url));
if (process.argv.includes("--check")) {
  if ((await readFile(artifact, "utf8")) !== output)
    throw new Error(
      "openapi.json is stale; run npm run openapi:generate --workspace @greenroom/contracts",
    );
} else await writeFile(artifact, output);
