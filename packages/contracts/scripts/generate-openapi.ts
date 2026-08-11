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
  communicationsHistoryParamsSchema,
  communicationsHistoryResponseSchema,
  createTemplateInputSchema,
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
  prospectOwnerListResponseSchema,
  prospectPathSchema,
  prospectResponseSchema,
  organizerReviewWorkspaceSchema,
  proposalDecisionResponseSchema,
  proposalStatusesResponseSchema,
  proposalTransitionResponseSchema,
  recordProposalDecisionInputSchema,
  reviewAssignmentRemovalResponseSchema,
  reviewAssignmentsResponseSchema,
  reviewConflictResponseSchema,
  reviewerQueueSchema,
  reviewAssignmentParamsSchema,
  reviewEventParamsSchema,
  reviewOrganizerQuerySchema,
  reviewPlanResponseSchema,
  saveEvaluationInputSchema,
  setSpeakerPhotoInputSchema,
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
  deliveryIdParamsSchema,
  deliveryResponseSchema,
  retryDeliveryInputSchema,
  templateResponseSchema,
  triggerDeliveryInputSchema,
  publicEventResponseSchema,
  publicEventSlugParamsSchema,
  publicationPreviewResponseSchema,
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
  path: "/api/public/events/{slug}",
  request: { params: publicEventSlugParamsSchema },
  responses: {
    200: {
      description: "Immutable public event snapshot",
      content: json(publicEventResponseSchema),
    },
    404: errorResponse,
    500: errorResponse,
  },
});
for (const action of ["preview", "publish", "unpublish"] as const)
  registry.registerPath({
    method: action === "preview" ? "get" : "post",
    path: `/api/publishing/events/{eventId}/${action}`,
    security: [{ sessionCookie: [] }],
    request: { params: eventIdParamsSchema },
    responses: {
      200: {
        description: `Publication ${action}`,
        content: json(publicationPreviewResponseSchema),
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
  description:
    "Atomically transitions every named proposal or applies none. The reserved decision statuses are refused here: reaching `accepted`/`declined` is the effect of a recorded decision, so `POST /api/events/{eventId}/review/decisions` is what records one.",
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
  method: "post",
  path: "/api/events/{eventId}/review/decisions",
  description:
    "Records an accept/decline decision and moves the proposal to the matching reserved status. For an accepted outcome the same request also creates the session, because the recorded decision is what authorizes it; `acceptances` reports which half happened per proposal. A `decision_only` entry means the decision is durable and the session was refused, so re-posting the identical decision retries it.",
  security: [{ sessionCookie: [] }],
  request: {
    params: reviewEventParamsSchema,
    body: { required: true, content: json(recordProposalDecisionInputSchema) },
  },
  responses: {
    201: {
      description: "Recorded acceptance decisions",
      content: json(proposalDecisionResponseSchema),
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
  method: "delete",
  path: "/api/events/{eventId}/review/assignments/{assignmentId}",
  description:
    "Removes a review assignment, together with any draft evaluation or declared conflict hanging off it. This is how a mis-assignment is corrected and how the evaluation rubric — locked while any assignment exists — is unlocked again. Refused with 400 once that reviewer has completed their evaluation, because the score is already counted in the abstract's aggregate.",
  security: [{ sessionCookie: [] }],
  request: { params: reviewAssignmentParamsSchema },
  responses: {
    200: {
      description: "Removed reviewer assignment",
      content: json(reviewAssignmentRemovalResponseSchema),
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
  path: "/api/events/assigned",
  // Requires a session and answers 401 without one, which is why it is not under
  // `/api/public`: nothing in that namespace may demand a session.
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: "Events the session holds any role on",
      content: json(eventListResponseSchema),
    },
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
    // Throttled per client address and event; the response carries `Retry-After`.
    429: errorResponse,
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
  description:
    "Turns a proposal that carries an accepted review decision into a session. Title, abstract, format and speaker identity are resolved server-side; unknown proposals answer 404 and undecided ones 409.",
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
    404: errorResponse,
    409: errorResponse,
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
  method: "put",
  path: "/api/speaker-profiles/{profileId}/photo",
  description:
    "Records which of this speaker's own uploads is their headshot. The owning speaker or an organizer of the event may set it; anybody else is refused exactly like a profile that does not exist. It changes no asset visibility: a private upload stays private and the public page shows initials until an organizer marks that asset publishable. A file belonging to another profile, or one that is not an image, answers 400 naming `assetId`.",
  security: [{ sessionCookie: [] }],
  request: {
    params: profileParamsSchema,
    body: { required: true, content: json(setSpeakerPhotoInputSchema) },
  },
  responses: {
    200: {
      description: "Speaker profile carrying the chosen headshot",
      content: json(z.object({ profile: speakerProfileSchema })),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "delete",
  path: "/api/speaker-profiles/{profileId}/photo",
  description:
    "Removes the headshot choice and leaves the uploaded file in place. Same authority as setting it.",
  security: [{ sessionCookie: [] }],
  request: { params: profileParamsSchema },
  responses: {
    200: {
      description: "Speaker profile with no headshot",
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
  method: "get",
  path: "/api/speaker-assets/{assetId}",
  // Deliberately unauthenticated: an asset an organizer marked publishable is public.
  // A private asset is indistinguishable from a missing one, so this returns 404 rather
  // than 403 for a caller who may not read it.
  request: { params: speakerAssetParamsSchema },
  responses: {
    200: {
      description:
        "Raw asset bytes. Readable by anyone while the asset is publishable and its event is published; otherwise only by the owning speaker or an event organizer.",
      content: { "*/*": { schema: { type: "string", format: "binary" } } },
    },
    304: { description: "Unchanged since the ETag the caller supplied" },
    400: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "delete",
  path: "/api/speaker-assets/{assetId}",
  // The uploading speaker or an organizer of the event. An unknown id and an asset on
  // another event are refused identically, so neither can be told from the other.
  security: [{ sessionCookie: [] }],
  request: { params: speakerAssetParamsSchema },
  responses: {
    204: { description: "Asset row and stored object removed" },
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
  method: "post",
  path: "/api/speaker-assets/{assetId}/unpublish",
  security: [{ sessionCookie: [] }],
  request: { params: speakerAssetParamsSchema },
  responses: {
    200: {
      description: "Asset returned to private, ending anonymous reads",
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
  method: "delete",
  path: "/api/content-sessions/{sessionId}",
  description:
    "Withdraws a session from the programme: the session is removed and every agenda placement holding it is dropped, so the board cannot keep a slot for a session that no longer exists. Organizer-only, and the reverse of accepting a proposal — the path back when an accepted abstract is later declined. The speaker profile, its tasks, and its uploads are left alone, and the withdrawn session leaves the public page at the next publish because published snapshots are immutable. Answers the refreshed content workspace.",
  security: [{ sessionCookie: [] }],
  request: { params: contentSessionParamsSchema },
  responses: {
    200: {
      description: "Content workspace with the withdrawn session removed",
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
  description:
    "RFC 5545 stream of the speaker's scheduled sessions. Answers 404 when none is scheduled, because section 3.4 requires a VCALENDAR to carry at least one component.",
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
    404: errorResponse,
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
  path: "/api/public/events/{slug}/schedule",
  request: { params: publicEventSlugParamsSchema },
  responses: {
    200: {
      description:
        "Sessions the published projection places, under the agenda publication in force",
      content: json(z.object({ schedule: publicScheduleSchema })),
    },
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
  path: "/api/events/{eventId}/prospects/owners",
  security: [{ sessionCookie: [] }],
  request: { params: eventIdParamsSchema },
  responses: {
    200: {
      description: "Users assignable as the owner of a prospect on this event",
      content: json(prospectOwnerListResponseSchema),
    },
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

registry.registerPath({
  method: "post",
  path: "/api/communications/templates",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(createTemplateInputSchema) } },
  responses: {
    201: { description: "Immutable template version", content: json(templateResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/communications/deliveries",
  security: [{ sessionCookie: [] }],
  request: { body: { required: true, content: json(triggerDeliveryInputSchema) } },
  responses: {
    202: { description: "Queued or existing delivery", content: json(deliveryResponseSchema) },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "get",
  path: "/api/communications/history",
  security: [{ sessionCookie: [] }],
  request: { query: communicationsHistoryParamsSchema },
  responses: {
    200: {
      description: "Auditable delivery history",
      content: json(communicationsHistoryResponseSchema),
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
});
registry.registerPath({
  method: "post",
  path: "/api/communications/deliveries/{deliveryId}/retry",
  security: [{ sessionCookie: [] }],
  request: {
    params: deliveryIdParamsSchema,
    query: retryDeliveryInputSchema,
  },
  responses: {
    200: { description: "Explicitly requeued delivery", content: json(deliveryResponseSchema) },
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
