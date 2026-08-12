/**
 * Speaker profiles, tasks, uploads, headshot selection, session edits and the calendar export.
 *
 * Owned by the `content` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
 */
import {
  acceptContentInputSchema,
  contentSessionParamsSchema,
  eventContentParamsSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  setSpeakerPhotoInputSchema,
  speakerAssetParamsSchema,
  taskParamsSchema,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
  uploadSpeakerAssetInputSchema,
  createSpeakerResourceInputSchema,
  updateSpeakerResourceInputSchema,
  speakerResourceParamsSchema,
  bulkRequestSpeakerTaskInputSchema,
  speakerCsvImportInputSchema,
  updateSpeakerWorkflowInputSchema,
  addContentCommentInputSchema,
  restoreContentRevisionInputSchema,
} from "@greenroom/contracts";
import {
  ResourceEmbedDeniedError,
  SpeakerIdentityUnavailableError,
  SpeakerPhotoInvalidError,
} from "../../../application/content/content-service";
import { requireCapability, requireEventCapability } from "../../../application/identity/actor";
import { envelope, validationFields, readJson, PUBLIC_CACHE_CONTROL } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/content",
  "POST /api/events/:eventId/content/accept",
  "PATCH /api/speaker-profiles/:profileId",
  "PUT /api/speaker-profiles/:profileId/photo",
  "DELETE /api/speaker-profiles/:profileId/photo",
  "POST /api/events/:eventId/tasks/:taskId/complete",
  "POST /api/speaker-tasks",
  "POST /api/speaker-messages",
  "PATCH /api/content-sessions/:sessionId",
  "DELETE /api/content-sessions/:sessionId",
  "GET /api/speaker-assets/:assetId",
  "POST /api/speaker-assets/:assetId/publish",
  "POST /api/speaker-assets/:assetId/unpublish",
  "DELETE /api/speaker-assets/:assetId",
  "POST /api/speaker-assets",
  "GET /api/events/:eventId/speaker-calendar.ics",
  "POST /api/speaker-resources",
  "PATCH /api/speaker-resources/:resourceId",
  "DELETE /api/speaker-resources/:resourceId",
  "POST /api/speaker-imports",
  "POST /api/speaker-tasks/bulk",
  "PATCH /api/speaker-profiles/:profileId/workflow",
  "POST /api/content-comments",
  "POST /api/content-revisions/restore",
] as const;

export const contentRoutes: RouteModule = {
  domain: "content",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { content } = dependencies;
    app.get("/api/events/:eventId/content", async (context) => {
      const parsed = eventContentParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), parsed.data.eventId, "content:read");
      if (!content) throw new Error("Content service is unavailable");
      return context.json(await content.workspace(context.get("actor"), parsed.data.eventId));
    });
    app.post("/api/events/:eventId/content/accept", async (context) => {
      const params = eventContentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "content:manage");
      const parsed = acceptContentInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Accepted content is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        await content.accept(
          context.get("actor"),
          { eventId: params.data.eventId, proposalId: parsed.data.proposalId },
          context.get("correlationId"),
        ),
        201,
      );
    });
    app.patch("/api/speaker-profiles/:profileId", async (context) => {
      requireCapability(context.get("actor"), "content:read");
      const params = profileParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = updateSpeakerProfileInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker profile is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        profile: await content.updateMyProfile(
          context.get("actor"),
          params.data.profileId,
          parsed.data,
        ),
      });
    });
    /*
     * Which uploaded file is this speaker's headshot.
     *
     * Its own address rather than a field on the PATCH above, because the two carry different
     * authority: the profile text is the speaker's to write, while an organizer of the event
     * may also set or remove the headshot on the programme they run. The service decides which
     * of the two the caller is; a reviewer and an unrelated speaker are refused.
     *
     * Naming a photo publishes nothing. The asset keeps whatever visibility it had, so a
     * private upload stays private and the public page shows initials until an organizer
     * separately marks that asset publishable — `POST /api/speaker-assets/{assetId}/publish`.
     * A file that is not this speaker's, or is not an image, is a 400 naming `assetId`.
     */
    app.put("/api/speaker-profiles/:profileId/photo", async (context) => {
      requireCapability(context.get("actor"), "content:read");
      const params = profileParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = setSpeakerPhotoInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "That profile photo reference is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        profile: await content.setProfilePhoto(
          context.get("actor"),
          params.data.profileId,
          parsed.data.assetId,
        ),
      });
    });
    /* Withdrawing the choice needs no more authority than making it, and keeps the file. */
    app.delete("/api/speaker-profiles/:profileId/photo", async (context) => {
      requireCapability(context.get("actor"), "content:read");
      const params = profileParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Profile ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        profile: await content.clearProfilePhoto(context.get("actor"), params.data.profileId),
      });
    });
    app.post("/api/events/:eventId/tasks/:taskId/complete", async (context) => {
      const eventParams = eventContentParamsSchema.safeParse(context.req.param());
      const taskParams = taskParamsSchema.safeParse(context.req.param());
      if (!eventParams.success || !taskParams.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Task reference is malformed.",
            context.get("correlationId"),
          ),
          400,
        );
      requireEventCapability(context.get("actor"), eventParams.data.eventId, "content:read");
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        await content.completeTask(
          context.get("actor"),
          taskParams.data.taskId,
          eventParams.data.eventId,
        ),
      );
    });
    app.post("/api/speaker-tasks", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const parsed = requestSpeakerTaskInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker task is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        { task: await content.requestTask(context.get("actor"), parsed.data) },
        201,
      );
    });
    app.post("/api/speaker-messages", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const parsed = recordSpeakerMessageInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker message is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        { message: await content.recordMessage(context.get("actor"), parsed.data) },
        201,
      );
    });
    app.patch("/api/content-sessions/:sessionId", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const params = contentSessionParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Session ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = updateContentSessionInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Session content is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        session: await content.updateSession(
          context.get("actor"),
          params.data.sessionId,
          parsed.data,
        ),
      });
    });
    /*
     * Withdraw a session from the programme.
     *
     * Organizer-only, and the counterpart of `POST /content/accept`: an abstract accepted by
     * mistake, or accepted and then declined, leaves content through here. The service drops the
     * session's agenda placements through the agenda's public application interface first, so the
     * board is never left holding a placement for a session that no longer exists. The refreshed
     * workspace comes back so the caller sees the programme it produced.
     */
    app.delete("/api/content-sessions/:sessionId", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const params = contentSessionParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Session ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        await content.withdrawSession(context.get("actor"), params.data.sessionId),
      );
    });
    app.get("/api/speaker-assets/:assetId", async (context) => {
      const params = speakerAssetParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      // Authorization lives in the service: an asset is public only while it is publishable
      // *and* its event is published; private ones reach only the owning speaker or an
      // organizer of the event. A withheld asset and a missing one are the same 404, so ids
      // cannot be enumerated (`ARC-AUTH-001`).
      const found = await content.readAsset(context.get("actor"), params.data.assetId);
      if (!found)
        return context.json(
          envelope("NOT_FOUND", "The asset was not found.", context.get("correlationId")),
          404,
        );
      // Uploaded bytes never change — there is no replace route — so identity plus upload
      // instant is a strong validator, and the revalidation the policy below demands costs a
      // bodyless 304 rather than the file.
      const validator = `"${found.asset.id}-${found.asset.uploadedAt}"`;
      const headers = {
        // Only bytes served through the *public* door may be stored by a shared cache: the
        // same publishable asset is also served to its owner while the event is unpublished,
        // and that response must never end up in front of the public. Storable, never used
        // unvalidated — returning an asset to private has to be visible on the next request.
        "cache-control": found.publiclyReadable ? PUBLIC_CACHE_CONTROL : "private, no-store",
        etag: validator,
        // Uploaded files are untrusted; never let a browser execute one inline.
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      };
      // `context.body` rather than a raw `Response`: a raw one drops the headers prepared by
      // the middleware above, which is how these bytes used to be served with no correlation id.
      if (context.req.header("if-none-match")?.includes(validator))
        return context.body(null, 304, headers);
      return context.body(found.bytes as unknown as ArrayBuffer, 200, {
        ...headers,
        "content-type": found.contentType,
        "content-length": String(found.bytes.byteLength),
      });
    });
    app.post("/api/speaker-assets/:assetId/publish", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const params = speakerAssetParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        asset: await content.publishAsset(context.get("actor"), params.data.assetId),
      });
    });
    /*
     * Publication is reversible. An asset published by mistake goes back to `private`, which
     * closes the public door immediately: the read above serves no lifetime a cache could
     * spend on the withdrawn bytes. Organizer-only, like publishing it.
     */
    app.post("/api/speaker-assets/:assetId/unpublish", async (context) => {
      requireCapability(context.get("actor"), "content:manage");
      const params = speakerAssetParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        asset: await content.unpublishAsset(context.get("actor"), params.data.assetId),
      });
    });
    /*
     * Deletion removes the row and the stored object together. The speaker who uploaded the
     * file may take it back, and an organizer of the event may remove one that should never
     * have been received. An unknown id and an asset on someone else's event are refused
     * identically, so neither reveals the other (`ARC-AUTH-001`).
     */
    app.delete("/api/speaker-assets/:assetId", async (context) => {
      requireCapability(context.get("actor"), "content:read");
      const params = speakerAssetParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Asset ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      await content.deleteAsset(context.get("actor"), params.data.assetId);
      return context.body(null, 204);
    });
    app.post("/api/speaker-assets", async (context) => {
      requireCapability(context.get("actor"), "content:read");
      const parsed = uploadSpeakerAssetInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker asset is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      const binary = atob(parsed.data.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return context.json(
        { asset: await content.upload(context.get("actor"), { ...parsed.data, bytes }) },
        201,
      );
    });
    app.get("/api/events/:eventId/speaker-calendar.ics", async (context) => {
      const parsed = eventContentParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), parsed.data.eventId, "content:read");
      if (!content) throw new Error("Content service is unavailable");
      const document = await content.calendar(context.get("actor"), parsed.data.eventId);
      // RFC 5545 section 3.4 requires at least one component, so a speaker with nothing scheduled
      // has no calendar to download rather than a VCALENDAR every calendar client refuses.
      if (!document)
        return context.json(
          envelope(
            "NOT_FOUND",
            "You have no scheduled sessions to export yet.",
            context.get("correlationId"),
          ),
          404,
        );
      return context.body(document, 200, {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'attachment; filename="greenroom-sessions.ics"',
      });
    });
    app.post("/api/speaker-imports", async (context) => {
      const parsed = speakerCsvImportInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker CSV import is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        await content.importSpeakers(
          context.get("actor"),
          parsed.data,
          context.get("correlationId"),
        ),
      );
    });
    app.post("/api/speaker-tasks/bulk", async (context) => {
      const parsed = bulkRequestSpeakerTaskInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Bulk task request is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        { tasks: await content.requestTasks(context.get("actor"), parsed.data) },
        201,
      );
    });
    app.patch("/api/speaker-profiles/:profileId/workflow", async (context) => {
      const params = profileParamsSchema.safeParse(context.req.param());
      const parsed = updateSpeakerWorkflowInputSchema.safeParse(await readJson(context.req));
      if (!params.success || !parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker workflow is invalid.",
            context.get("correlationId"),
            parsed.success ? undefined : validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        profile: await content.updateSpeakerWorkflow(
          context.get("actor"),
          params.data.profileId,
          parsed.data,
        ),
      });
    });
    app.post("/api/speaker-resources", async (context) => {
      const parsed = createSpeakerResourceInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker resource is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        { resource: await content.createResource(context.get("actor"), parsed.data) },
        201,
      );
    });
    app.post("/api/content-comments", async (context) => {
      const parsed = addContentCommentInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Comment is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        {
          comment: await content.addAssetComment(
            context.get("actor"),
            parsed.data.assetId,
            parsed.data.body,
          ),
        },
        201,
      );
    });
    app.post("/api/content-revisions/restore", async (context) => {
      const parsed = restoreContentRevisionInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Revision is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        await content.restoreRevision(context.get("actor"), parsed.data.revisionId),
      );
    });
    app.patch("/api/speaker-resources/:resourceId", async (context) => {
      const params = speakerResourceParamsSchema.safeParse(context.req.param());
      const parsed = updateSpeakerResourceInputSchema.safeParse(await readJson(context.req));
      if (!params.success || !parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker resource is invalid.",
            context.get("correlationId"),
            parsed.success ? undefined : validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        resource: await content.updateResource(
          context.get("actor"),
          params.data.resourceId,
          parsed.data,
        ),
      });
    });
    app.delete("/api/speaker-resources/:resourceId", async (context) => {
      const params = speakerResourceParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Resource ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      await content.deleteResource(context.get("actor"), params.data.resourceId);
      return context.body(null, 204);
    });
  },
  translateError(error: unknown) {
    if (error instanceof SpeakerIdentityUnavailableError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "The speaker identity could not be created.",
        status: 400 as const,
        fields: error.fields,
      };
    if (error instanceof SpeakerPhotoInvalidError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: "That file cannot be used as a profile photo.",
        status: 400 as const,
        fields: error.fields,
      };
    if (error instanceof ResourceEmbedDeniedError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
        fields: { embedHtml: [error.message] },
      };
    return null;
  },
};
