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
  addContentCommentInputSchema,
  assignSpeakerChecklistInputSchema,
  bulkDownloadDeliverablesInputSchema,
  clearSpeakerPhotoInputSchema,
  remindSpeakerTasksInputSchema,
  bulkRequestSpeakerTaskInputSchema,
  contentSessionParamsSchema,
  createSpeakerResourceInputSchema,
  eventContentParamsSchema,
  inviteSpeakersInputSchema,
  profileParamsSchema,
  recordSpeakerMessageInputSchema,
  requestSpeakerTaskInputSchema,
  restoreContentRevisionInputSchema,
  saveSpeakerTaskTemplatesInputSchema,
  speakerTaskTemplateIdParamsSchema,
  speakerTaskTemplateInputSchema,
  setSpeakerPhotoInputSchema,
  speakerAssetParamsSchema,
  speakerCsvImportInputSchema,
  speakerResourceParamsSchema,
  taskParamsSchema,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
  updateSpeakerResourceInputSchema,
  updateSpeakerWorkflowInputSchema,
  uploadSpeakerAssetInputSchema,
} from "@greenroom/contracts";
import { ContentConflictError } from "../../../application/content/content-repository";
import {
  ContentNotFoundError,
  ResourceEmbedDeniedError,
  SpeakerChecklistAnchorError,
  SpeakerChecklistTitleTakenError,
  SpeakerIdentityUnavailableError,
  SpeakerPhotoInvalidError,
  SpeakerRemindersUnavailableError,
} from "../../../application/content/content-service";
import { requireCapability, requireEventCapability } from "../../../application/identity/actor";
import { envelope, PUBLIC_CACHE_CONTROL, readJson, validationFields } from "../runtime";
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
  "POST /api/events/:eventId/speaker-calendar-invites",
  "GET /api/events/:eventId/speaker-task-templates",
  "POST /api/events/:eventId/speaker-task-templates",
  "POST /api/events/:eventId/speaker-task-template-entries",
  "PATCH /api/speaker-task-templates/:templateId",
  "DELETE /api/speaker-task-templates/:templateId",
  "POST /api/events/:eventId/speaker-checklist-assignments",
  "POST /api/speaker-resources",
  "PATCH /api/speaker-resources/:resourceId",
  "DELETE /api/speaker-resources/:resourceId",
  "POST /api/speaker-imports",
  "POST /api/speaker-tasks/bulk",
  "PATCH /api/speaker-profiles/:profileId/workflow",
  "POST /api/content-comments",
  "POST /api/content-revisions/restore",
  "POST /api/content-deliverables/bulk-download",
  "POST /api/content-task-reminders",
  "POST /api/speaker-invitations",
] as const;

export const contentRoutes: RouteModule = {
  domain: "content",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { content, speakerCalendarInvites } = dependencies;
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
        profile: await content.updateProfile(
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
          parsed.data.expectedVersion,
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
      const parsed = clearSpeakerPhotoInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "That profile version is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json({
        profile: await content.clearProfilePhoto(
          context.get("actor"),
          params.data.profileId,
          parsed.data.expectedVersion,
        ),
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
    app.post("/api/events/:eventId/speaker-calendar-invites", async (context) => {
      const parsed = eventContentParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!speakerCalendarInvites) throw new Error("Calendar invitations are unavailable");
      return context.json(
        await speakerCalendarInvites.send(context.get("actor"), parsed.data.eventId),
        202,
      );
    });
    /*
     * The event's speaker checklist: what every speaker is asked for, held once as event
     * configuration instead of retyped per person per year.
     *
     * Reading the checklist is organizer work, and the service is what decides that: a speaker
     * holds `content:read` for their own portal, and a line nobody has been given yet is a
     * draft of somebody's future work rather than part of the portal it will land in.
     */
    app.get("/api/events/:eventId/speaker-task-templates", async (context) => {
      const params = eventContentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "content:read");
      if (!content) throw new Error("Content service is unavailable");
      return context.json({
        templates: await content.taskTemplates(context.get("actor"), params.data.eventId),
      });
    });
    /*
     * Declaring the checklist, not replacing it: every line is written at its
     * `(event_id, title)` identity, so sending the same one twice converges, and a line this
     * request does not name is left where it is rather than deleted by omission.
     */
    app.post("/api/events/:eventId/speaker-task-templates", async (context) => {
      const params = eventContentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "content:manage");
      const parsed = saveSpeakerTaskTemplatesInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Speaker checklist is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      await content.importTaskTemplates(context.get("actor"), {
        eventId: params.data.eventId,
        templates: parsed.data.templates,
        commit: true,
      });
      // Answered from the store rather than from the write's own report, so the response is the
      // whole checklist the organizer now has — including the lines this request left alone.
      return context.json({
        templates: await content.taskTemplates(context.get("actor"), params.data.eventId),
      });
    });
    /*
     * One line at a time, addressed by its own id — the console's authoring path (issue #176).
     *
     * The bulk route above declares a whole checklist at `(event_id, title)`, which is right for
     * a clone and wrong for a person: an organizer who mistyped a title cannot correct it that
     * way, because the corrected title writes a *second* line and nothing there removes the
     * first. So authoring gets its own three verbs, and every one of them answers with the whole
     * checklist rather than with the row it touched — a reorder changes rows the request never
     * named, and a console reconstructing that from a single row would show a stale order.
     */
    app.post("/api/events/:eventId/speaker-task-template-entries", async (context) => {
      const params = eventContentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "content:manage");
      const parsed = speakerTaskTemplateInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Checklist line is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      await content.createTaskTemplate(context.get("actor"), {
        eventId: params.data.eventId,
        ...parsed.data,
      });
      return context.json(
        { templates: await content.taskTemplates(context.get("actor"), params.data.eventId) },
        201,
      );
    });
    app.patch("/api/speaker-task-templates/:templateId", async (context) => {
      const params = speakerTaskTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Template ID is malformed.", context.get("correlationId")),
          400,
        );
      const parsed = speakerTaskTemplateInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Checklist line is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      /*
       * The event is resolved from the stored line rather than taken from the request, so this
       * route has no event parameter to disagree with the row it edits. The service authorizes
       * against that event and answers the same denial for a line on an event this actor cannot
       * write as for one that does not exist — and, for the same reason, for a line another
       * organizer has deleted since this form was opened. A 403 here is as likely to mean "that
       * line is gone" as "not yours", which is the price of not being an oracle for other
       * organizations' ids.
       */
      const saved = await content.updateTaskTemplate(
        context.get("actor"),
        params.data.templateId,
        parsed.data,
      );
      return context.json({
        templates: await content.taskTemplates(context.get("actor"), saved.eventId),
      });
    });
    app.delete("/api/speaker-task-templates/:templateId", async (context) => {
      const params = speakerTaskTemplateIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Template ID is malformed.", context.get("correlationId")),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      /*
       * The event comes back from the delete, which is the only thing that still knows it.
       *
       * A repeat of this request — a retry, a double click that got through — answers 403 rather
       * than 200, because a line that is already gone is refused exactly as one that never
       * existed. That single refusal is deliberate (it is what stops this route being an oracle
       * for another organization's ids) and the consequence is worth naming here: a 403 on the
       * second attempt is not a permission problem, it is the first attempt having succeeded.
       */
      const eventId = await content.deleteTaskTemplate(
        context.get("actor"),
        params.data.templateId,
      );
      return context.json({
        templates: await content.taskTemplates(context.get("actor"), eventId),
      });
    });
    /*
     * Turn the checklist into real work for named speakers.
     *
     * A separate, deliberate command rather than a consequence of declaring the lines: this is
     * what puts dated tasks in people's portals and mails them about it. Idempotent per
     * `(profile, line)`, so running it again after a speaker joins brings only the newcomer up
     * to date and leaves everybody else's work — and their completions — alone.
     */
    app.post("/api/events/:eventId/speaker-checklist-assignments", async (context) => {
      const params = eventContentParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "content:manage");
      const parsed = assignSpeakerChecklistInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Checklist assignment is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      return context.json(
        {
          tasks: await content.assignTaskChecklist(context.get("actor"), {
            eventId: params.data.eventId,
            profileIds: parsed.data.profileIds,
            anchorAt: parsed.data.anchorAt,
          }),
        },
        201,
      );
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
    app.post("/api/content-deliverables/bulk-download", async (context) => {
      const parsed = bulkDownloadDeliverablesInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Deliverable selection is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      const archive = await content.bulkDownload(
        context.get("actor"),
        parsed.data.eventId,
        parsed.data.assetIds,
      );
      return context.body(archive as unknown as ArrayBuffer, 200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="speaker-deliverables.zip"',
        "content-length": String(archive.byteLength),
      });
    });
    /*
     * Chase a chosen set of open tasks.
     *
     * Deliberately the *same* delivery key the automatic sweep uses, so pressing this on work
     * already covered converges on that delivery and reports "already sent" rather than writing
     * to the speaker twice. Every task comes back in the response, including the ones nothing was
     * sent for: an organizer not told that a speaker has no address keeps waiting for a reply to
     * a message that never left (`PRD-SPK-002`).
     */
    app.post("/api/content-task-reminders", async (context) => {
      const parsed = remindSpeakerTasksInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Reminder selection is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      try {
        return context.json({
          reminders: await content.remindTasks(
            context.get("actor"),
            parsed.data.eventId,
            parsed.data.taskIds,
          ),
        });
      } catch (error) {
        if (error instanceof ContentNotFoundError)
          return context.json(
            envelope("NOT_FOUND", error.message, context.get("correlationId")),
            404,
          );
        // Configuration rather than a bad request: no delivering domain bound, or an event with
        // no owning organization. The closed error vocabulary already has the member for "a
        // thing this request depends on is not answering", so it is reused rather than widened.
        if (error instanceof SpeakerRemindersUnavailableError)
          return context.json(
            envelope("UPSTREAM_UNAVAILABLE", error.message, context.get("correlationId")),
            503,
          );
        throw error;
      }
    });
    /*
     * Invite a chosen set of speakers into the portal, again if need be.
     *
     * Deliberately *not* the delivery key acceptance's welcome uses. That one names the person
     * and never moves, which is why a speaker who lost the mail could not be invited a second
     * time by anybody; each invitation here claims its own occurrence and is keyed on that, so a
     * re-invitation is a delivery the organizer can see. Every speaker named comes back in the
     * response, including the ones nothing was sent for, for the reason the reminder route gives
     * above (`PRD-SPK-002`).
     */
    app.post("/api/speaker-invitations", async (context) => {
      const parsed = inviteSpeakersInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Invitation selection is invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      if (!content) throw new Error("Content service is unavailable");
      try {
        return context.json({
          invitations: await content.inviteSpeakers(
            context.get("actor"),
            parsed.data.eventId,
            parsed.data.profileIds,
          ),
        });
      } catch (error) {
        if (error instanceof ContentNotFoundError)
          return context.json(
            envelope("NOT_FOUND", error.message, context.get("correlationId")),
            404,
          );
        // The same configuration failure the reminder route reports, and the same code: no
        // delivering domain bound, or an event with no owning organization.
        if (error instanceof SpeakerRemindersUnavailableError)
          return context.json(
            envelope("UPSTREAM_UNAVAILABLE", error.message, context.get("correlationId")),
            503,
          );
        throw error;
      }
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
    // An anchor that is not an instant is the caller's to fix, and naming the field is what
    // lets them: the offsets are counted from it, so nothing can be dated without it.
    if (error instanceof SpeakerChecklistAnchorError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
        fields: { anchorAt: [error.message] },
      };
    /*
     * A title another line already holds. 409 rather than 400: the request is well formed and
     * the checklist's state is what refuses it, which is also the state the organizer can see
     * and act on. Named against `title`, because that is the box they retype.
     */
    if (error instanceof SpeakerChecklistTitleTakenError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
        fields: { title: [error.message] },
      };
    if (error instanceof ResourceEmbedDeniedError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
        fields: { embedHtml: [error.message] },
      };
    if (error instanceof ContentConflictError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
      };
    return null;
  },
};
