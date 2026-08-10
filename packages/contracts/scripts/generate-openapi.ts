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
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventListResponseSchema,
  eventIdParamsSchema,
  healthResponseSchema,
  sessionResponseSchema,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  agendaDraftSchema,
  publishedScheduleSchema,
  publicScheduleSchema,
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
  path: "/api/events/{eventId}/agenda",
  security: [{ sessionCookie: [] }],
  request: { params: agendaIdParamsSchema },
  responses: {
    200: {
      description: "Organizer agenda draft and conflicts",
      content: json(z.object({ agenda: agendaDraftSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "put",
  path: "/api/events/{eventId}/agenda/resources",
  security: [{ sessionCookie: [] }],
  request: {
    params: agendaIdParamsSchema,
    body: { required: true, content: json(agendaResourcesSchema) },
  },
  responses: {
    200: {
      description: "Configured rooms, tracks, and timeslots",
      content: json(z.object({ agenda: agendaDraftSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "put",
  path: "/api/events/{eventId}/agenda/placements/{placementId}",
  security: [{ sessionCookie: [] }],
  request: {
    params: agendaIdParamsSchema.extend({ placementId: z.string() }),
    body: { required: true, content: json(agendaPlacementSchema) },
  },
  responses: {
    200: {
      description: "Updated draft and conflicts",
      content: json(z.object({ agenda: agendaDraftSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "delete",
  path: "/api/events/{eventId}/agenda/placements/{placementId}",
  security: [{ sessionCookie: [] }],
  request: { params: agendaIdParamsSchema.extend({ placementId: z.string() }) },
  responses: {
    204: { description: "Placement removed" },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/agenda/publications",
  security: [{ sessionCookie: [] }],
  request: { params: agendaIdParamsSchema },
  responses: {
    201: {
      description: "Auditable immutable schedule publication",
      content: json(z.object({ schedule: publicScheduleSchema })),
    },
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
  path: "/api/public/events/{eventId}/schedule",
  request: { params: agendaIdParamsSchema },
  responses: {
    200: {
      description: "Latest public-safe published schedule",
      content: json(z.object({ schedule: publishedScheduleSchema })),
    },
    400: errorResponse,
    404: errorResponse,
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
