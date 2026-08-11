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
  assignReviewersInputSchema,
  bulkProposalTransitionInputSchema,
  configureProposalStatusesInputSchema,
  configureReviewPlanInputSchema,
  cfpResponseSchema,
  cfpStateInputSchema,
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
  organizerReviewWorkspaceSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewerQueueSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  reviewOrganizerQuerySchema,
  reviewPlanResponseSchema,
  saveEvaluationInputSchema,
  evaluationResponseSchema,
  declareConflictInputSchema,
  sessionResponseSchema,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  agendaDraftSchema,
  publishedScheduleSchema,
  publicScheduleSchema,
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
  saveCfpInputSchema,
  submitProposalInputSchema,
  proposalConfirmationResponseSchema,
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
  path: "/api/events/{eventId}/review/organizer",
  security: [{ sessionCookie: [] }],
  request: { params: reviewEventParamsSchema, query: reviewOrganizerQuerySchema },
  responses: {
    200: {
      description: "Organizer triage, plan, assignments, audit, and outcomes",
      content: json(organizerReviewWorkspaceSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "put",
  path: "/api/events/{eventId}/review/plan",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewEventParamsSchema,
    body: { required: true, content: json(configureReviewPlanInputSchema) },
  },
  responses: {
    200: { description: "Saved evaluation plan", content: json(reviewPlanResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "put",
  path: "/api/events/{eventId}/review/statuses",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewEventParamsSchema,
    body: { required: true, content: json(configureProposalStatusesInputSchema) },
  },
  responses: {
    200: {
      description: "Saved event proposal statuses",
      content: json(proposalStatusesResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/review/assignments",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewEventParamsSchema,
    body: { required: true, content: json(assignReviewersInputSchema) },
  },
  responses: {
    201: {
      description: "Created reviewer assignments",
      content: json(reviewAssignmentsResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/review/transitions",
  description: "Atomically transitions every named proposal or applies none.",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewEventParamsSchema,
    body: { required: true, content: json(bulkProposalTransitionInputSchema) },
  },
  responses: {
    200: {
      description: "Atomic proposal transition",
      content: json(proposalTransitionResponseSchema),
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
  path: "/api/events/{eventId}/review/assignments",
  description: "Reviewer-owned assignment queue; aggregate outcomes are intentionally absent.",
  security: [{ sessionCookie: [] }],
  request: { params: reviewEventParamsSchema },
  responses: {
    200: { description: "Assigned reviewer queue", content: json(reviewerQueueSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/review/assignments/{assignmentId}/conflict",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewAssignmentParamsSchema,
    body: { required: true, content: json(declareConflictInputSchema) },
  },
  responses: {
    200: {
      description: "Declared assignment conflict",
      content: json(reviewConflictResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "put",
  path: "/api/events/{eventId}/review/assignments/{assignmentId}/evaluation",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewAssignmentParamsSchema,
    body: { required: true, content: json(saveEvaluationInputSchema) },
  },
  responses: {
    200: {
      description: "Saved draft or completed evaluation",
      content: json(evaluationResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/events/{eventId}/cfp",
  security: [{ sessionCookie: [] }],
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
  method: "put",
  path: "/api/events/{eventId}/cfp",
  security: [{ sessionCookie: [] }],
  request: {
    params: eventIdParamsSchema,
    body: { required: true, content: json(saveCfpInputSchema) },
  },
  responses: {
    200: { description: "Saved CFP draft", content: json(cfpResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/public/events",
  security: [{ sessionCookie: [] }],
  responses: {
    200: { description: "Publicly assigned events", content: json(eventListResponseSchema) },
    401: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/events/{eventId}/cfp/state",
  security: [{ sessionCookie: [] }],
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
      content: json(z.object({ schedule: publishedScheduleSchema })),
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
      content: json(z.object({ schedule: publicScheduleSchema })),
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
    409: errorResponse,
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
const patchOperation = document.paths["/api/events/{eventId}/prospects/{prospectId}"]?.patch as
  | { requestBody?: { content?: Record<string, { schema?: { minProperties?: number } }> } }
  | undefined;
const patchSchema = patchOperation?.requestBody?.content?.["application/json"]?.schema;
if (!patchSchema) throw new Error("CRM prospect PATCH schema was not generated");
patchSchema.minProperties = 1;
const output = `${JSON.stringify(document, null, 2)}\n`;
const artifact = fileURLToPath(new URL("../openapi.json", import.meta.url));
if (process.argv.includes("--check")) {
  if ((await readFile(artifact, "utf8")) !== output)
    throw new Error(
      "openapi.json is stale; run npm run openapi:generate --workspace @greenroom/contracts",
    );
} else await writeFile(artifact, output);
