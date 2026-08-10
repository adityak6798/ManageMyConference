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
  acceptContentInputSchema,
  contentWorkspaceSchema,
  contentSessionParamsSchema,
  contentSessionSchema,
  createEventInputSchema,
  createEventResponseSchema,
  demoSessionInputSchema,
  demoSessionResponseSchema,
  eventListResponseSchema,
  eventIdParamsSchema,
  healthResponseSchema,
  sessionResponseSchema,
  eventContentParamsSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  speakerProfileSchema,
  speakerMessageSchema,
  speakerTaskSchema,
  taskParamsSchema,
  updateSpeakerProfileInputSchema,
  uploadSpeakerAssetInputSchema,
  speakerAssetSchema,
  speakerAssetParamsSchema,
  updateContentSessionInputSchema,
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
  path: "/api/events/{eventId}/content",
  security: [{ sessionCookie: [] }],
  request: { params: eventContentParamsSchema },
  responses: {
    200: {
      description: "Organizer or speaker-scoped content workspace",
      content: json(contentWorkspaceSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/content/accept",
  security: [{ sessionCookie: [] }],
  request: {
    params: eventContentParamsSchema,
    body: { required: true, content: json(acceptContentInputSchema) },
  },
  responses: {
    201: { description: "Idempotently accepted content", content: json(contentWorkspaceSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "patch",
  path: "/api/speaker-profiles/{profileId}",
  security: [{ sessionCookie: [] }],
  request: {
    params: profileParamsSchema,
    body: { required: true, content: json(updateSpeakerProfileInputSchema) },
  },
  responses: {
    200: {
      description: "Updated speaker profile",
      content: json(z.object({ profile: speakerProfileSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/tasks/{taskId}/complete",
  security: [{ sessionCookie: [] }],
  request: { params: eventContentParamsSchema.merge(taskParamsSchema) },
  responses: {
    200: { description: "Completed speaker task", content: json(contentWorkspaceSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/speaker-assets",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(uploadSpeakerAssetInputSchema) } },
  responses: {
    201: {
      description: "Stored private or explicitly publishable asset metadata",
      content: json(z.object({ asset: speakerAssetSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/speaker-assets/{assetId}/publish",
  security: [{ sessionCookie: [] }],
  request: { params: speakerAssetParamsSchema },
  responses: {
    200: {
      description: "Organizer-approved publishable asset",
      content: json(z.object({ asset: speakerAssetSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "patch",
  path: "/api/content-sessions/{sessionId}",
  security: [{ sessionCookie: [] }],
  request: {
    params: contentSessionParamsSchema,
    body: { required: true, content: json(updateContentSessionInputSchema) },
  },
  responses: {
    200: {
      description: "Organizer-managed session content and readiness",
      content: json(z.object({ session: contentSessionSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/speaker-tasks",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(requestSpeakerTaskInputSchema) } },
  responses: {
    201: {
      description: "Organizer-requested speaker task",
      content: json(z.object({ task: speakerTaskSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/speaker-messages",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(recordSpeakerMessageInputSchema) } },
  responses: {
    201: {
      description: "Recorded speaker communication",
      content: json(z.object({ message: speakerMessageSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/events/{eventId}/speaker-calendar.ics",
  security: [{ sessionCookie: [] }],
  request: { params: eventContentParamsSchema },
  responses: {
    200: {
      description: "Deterministic speaker calendar",
      content: { "text/calendar": { schema: z.string() } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
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
