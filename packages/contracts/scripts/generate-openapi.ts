import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { ZodType } from "zod";
import {
  apiErrorEnvelopeSchema,
  createEventInputSchema,
  createEventResponseSchema,
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventListResponseSchema,
  healthResponseSchema,
} from "../src/index";

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
  request: { body: { content: json(demoSessionInputSchema) } },
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
  request: { body: { content: json(createEventInputSchema) } },
  responses: {
    201: { description: "Created event", content: json(createEventResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
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
