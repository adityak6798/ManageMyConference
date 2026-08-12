/**
 * Speaker profiles, tasks, uploads, sessions and the calendar export.
 *
 * Owned by the `content` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  acceptContentInputSchema,
  addContentCommentInputSchema,
  bulkDownloadDeliverablesInputSchema,
  bulkRequestSpeakerTaskInputSchema,
  contentCommentSchema,
  contentSessionParamsSchema,
  contentSessionSchema,
  contentWorkspaceSchema,
  createSpeakerResourceInputSchema,
  eventContentParamsSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  restoreContentRevisionInputSchema,
  setSpeakerPhotoInputSchema,
  speakerAssetParamsSchema,
  speakerAssetSchema,
  speakerCsvImportInputSchema,
  speakerCsvImportResultSchema,
  speakerMessageSchema,
  speakerProfileSchema,
  speakerResourceParamsSchema,
  speakerResourceSchema,
  speakerTaskSchema,
  taskParamsSchema,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
  updateSpeakerResourceInputSchema,
  updateSpeakerWorkflowInputSchema,
  uploadSpeakerAssetInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const contentPaths: OpenApiFragment = {
  domain: "content",
  register(registry, { json, errorResponse }) {
    /**
     * Two people edited the same speaker or session at the same moment, repeatedly.
     *
     * Carries its own description rather than reusing the standard envelope's, because this is
     * the one 4xx on these routes a client should answer by reloading and retrying rather than
     * by correcting the request — and a consumer reading the generated contract has no other
     * way to learn that.
     */
    const revisionConflictResponse = {
      ...errorResponse,
      description:
        "Contention, not a malformed request. Every profile and session edit records an attributed revision in the same transaction as the change itself, and a writer that loses the revision number five times running stops rather than writing from a copy the record has moved past. Nothing was changed; reload and try again.",
    };
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/content",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      path: "/api/speaker-resources",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(createSpeakerResourceInputSchema) } },
      responses: {
        201: {
          description: "Sanitized speaker resource",
          content: json(z.object({ resource: speakerResourceSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/speaker-imports",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(speakerCsvImportInputSchema) } },
      responses: {
        200: {
          description: "Speaker import preview or result",
          content: json(speakerCsvImportResultSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/content-comments",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(addContentCommentInputSchema) } },
      responses: {
        201: {
          description: "Attributed asset comment",
          content: json(z.object({ comment: contentCommentSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/content-deliverables/bulk-download",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(bulkDownloadDeliverablesInputSchema) } },
      responses: {
        200: {
          description: "Deterministic ZIP containing exactly the latest selected deliverables",
          content: { "application/zip": { schema: { type: "string", format: "binary" } } },
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: {
          ...errorResponse,
          description:
            "The selected deliverables exceed the 50 MB archive limit. The request is well formed and the caller is entitled to every file in it; there are simply too many bytes to return in one archive. Select fewer.",
        },
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/content-revisions/restore",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(restoreContentRevisionInputSchema) } },
      responses: {
        200: {
          description: "Workspace after restoring the selected revision",
          content: json(contentWorkspaceSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: revisionConflictResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/speaker-tasks/bulk",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { body: { required: true, content: json(bulkRequestSpeakerTaskInputSchema) } },
      responses: {
        201: {
          description: "Tasks assigned to selected speakers",
          content: json(z.object({ tasks: z.array(speakerTaskSchema) })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/speaker-profiles/{profileId}/workflow",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: profileParamsSchema,
        body: { required: true, content: json(updateSpeakerWorkflowInputSchema) },
      },
      responses: {
        200: {
          description: "Updated workflow and logistics fields",
          content: json(z.object({ profile: speakerProfileSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: revisionConflictResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "patch",
      path: "/api/speaker-resources/{resourceId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: speakerResourceParamsSchema,
        body: { required: true, content: json(updateSpeakerResourceInputSchema) },
      },
      responses: {
        200: {
          description: "Updated sanitized speaker resource",
          content: json(z.object({ resource: speakerResourceSchema })),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/speaker-resources/{resourceId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: speakerResourceParamsSchema },
      responses: {
        204: { description: "Resource deleted" },
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: {
        params: eventContentParamsSchema,
        body: { required: true, content: json(acceptContentInputSchema) },
      },
      responses: {
        201: {
          description: "Idempotently accepted content",
          content: json(contentWorkspaceSchema),
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
      method: "patch",
      path: "/api/speaker-profiles/{profileId}",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
        409: revisionConflictResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "put",
      path: "/api/speaker-profiles/{profileId}/photo",
      description:
        "Records which of this speaker's own uploads is their headshot. The owning speaker or an organizer of the event may set it; anybody else is refused exactly like a profile that does not exist. It changes no asset visibility: a private upload stays private and the public page shows initials until an organizer marks that asset publishable. A file belonging to another profile, or one that is not an image, answers 400 naming `assetId`.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
        409: revisionConflictResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/content-sessions/{sessionId}",
      description:
        "Withdraws a session from the programme: the session is removed and every agenda placement holding it is dropped, so the board cannot keep a slot for a session that no longer exists. Organizer-only, and the reverse of accepting a proposal — the path back when an accepted abstract is later declined. The speaker profile, its tasks, and its uploads are left alone, and the withdrawn session leaves the public page at the next publish because published snapshots are immutable. Answers the refreshed content workspace.",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
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
  },
};
