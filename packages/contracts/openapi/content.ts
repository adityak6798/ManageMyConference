/**
 * Speaker profiles, tasks, uploads, sessions and the calendar export.
 *
 * Owned by the `content` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import { z } from "zod";
import {
  acceptContentInputSchema,
  contentSessionParamsSchema,
  contentSessionSchema,
  contentWorkspaceSchema,
  eventContentParamsSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  setSpeakerPhotoInputSchema,
  speakerAssetParamsSchema,
  speakerAssetSchema,
  speakerMessageSchema,
  speakerProfileSchema,
  speakerTaskSchema,
  taskParamsSchema,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
  uploadSpeakerAssetInputSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const contentPaths: OpenApiFragment = {
  domain: "content",
  register(registry, { json, errorResponse }) {
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
  },
};
