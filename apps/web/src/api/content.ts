import {
  type AcceptContentInput,
  acceptContentInputSchema,
  type ContentWorkspaceDto,
  contentWorkspaceSchema,
  setSpeakerPhotoInputSchema,
  speakerCalendarInviteResultSchema,
  speakerChecklistAssignmentResponseSchema,
  speakerCsvImportResultSchema,
  type SpeakerTaskTemplateDto,
  type SpeakerTaskTemplateInput,
  speakerTaskTemplateListResponseSchema,
  type UpdateContentSessionInput,
  type UpdateSpeakerProfileInput,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
} from "@greenroom/contracts";
import { ZodError, type z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ContentApiError extends Error {
  constructor(readonly envelope: import("@greenroom/contracts").ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new ContentApiError(envelope));
}

export async function getContent(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<ContentWorkspaceDto> {
  return decode(await fetcher(`/api/events/${eventId}/content`), contentWorkspaceSchema);
}

/**
 * Turn a proposal the review domain already accepted into program content.
 *
 * The proposal id is the whole request: title, abstract, format, and the speaker's identity are
 * resolved server-side from the submission, so nothing here can invent a session or a speaker.
 */
export async function acceptContent(
  eventId: string,
  input: AcceptContentInput,
  fetcher: typeof fetch = fetch,
): Promise<ContentWorkspaceDto> {
  return decode(
    await fetcher(`/api/events/${eventId}/content/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(acceptContentInputSchema.parse(input)),
    }),
    contentWorkspaceSchema,
  );
}

/**
 * Field-level detail from a refused write, keyed by the input path that carried it.
 *
 * Two refusals reach a form and they used to be told apart by accident. The server's arrives as
 * a `ContentApiError` carrying `fieldErrors`; the *client's* arrives as a `ZodError`, because
 * every writer in this module validates before sending — which is a real early guard and also
 * means the request never happens, so there is no envelope to read. Reading only the first left
 * the second as a bare "could not be saved" with nothing beside the box that caused it.
 *
 * Both are keyed the same way — `issue.path.join(".")` is exactly what `validationFields` builds
 * on the server — so one reader serves both and a form cannot tell which side refused it.
 */
export function contentFieldErrors(error: unknown): Record<string, string[]> {
  if (error instanceof ContentApiError) return error.envelope.error.fieldErrors ?? {};
  if (error instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return fields;
  }
  return {};
}

export async function updateSpeakerProfile(
  profileId: string,
  input: UpdateSpeakerProfileInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const validated = updateSpeakerProfileInputSchema.parse(input);
  const response = await fetcher(`/api/speaker-profiles/${profileId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

/**
 * Record which upload is this speaker's headshot.
 *
 * The owning speaker does this from their portal; an organizer may do it from the content
 * workspace. It publishes nothing — the chosen file keeps whatever visibility it had, and the
 * public page shows initials until an organizer marks that asset publishable.
 */
export async function setSpeakerProfilePhoto(
  profileId: string,
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-profiles/${profileId}/photo`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(setSpeakerPhotoInputSchema.parse({ assetId })),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

/** Take the headshot off the profile; the uploaded file itself is untouched. */
export async function clearSpeakerProfilePhoto(
  profileId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-profiles/${profileId}/photo`, { method: "DELETE" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function completeSpeakerTask(
  eventId: string,
  taskId: string,
  fetcher: typeof fetch = fetch,
): Promise<ContentWorkspaceDto> {
  return decode(
    await fetcher(`/api/events/${eventId}/tasks/${taskId}/complete`, { method: "POST" }),
    contentWorkspaceSchema,
  );
}

export async function requestSpeakerTask(
  input: { profileId: string; title: string; dueAt: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/speaker-tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function recordSpeakerMessage(
  input: { profileId: string; subject: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/speaker-messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function uploadSpeakerAsset(
  input: {
    profileId: string;
    name: string;
    contentType: "image/jpeg" | "image/png" | "application/pdf";
    contentBase64: string;
    taskId?: string;
    sessionId?: string;
    versionGroupId?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/speaker-assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function updateContentSession(
  sessionId: string,
  input: UpdateContentSessionInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const validated = updateContentSessionInputSchema.parse(input);
  const response = await fetcher(`/api/content-sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

/**
 * Withdraw a session from the programme.
 *
 * Organizer-only, and the reverse of accepting the proposal: the session goes, and with it
 * every agenda placement holding it, so the board is not left with a slot for a session that
 * no longer exists. The speaker profile and their tasks and uploads stay — the same person may
 * be speaking elsewhere — and an already-live page appends a reconciled immutable projection
 * version on its next public read, so the withdrawn session cannot remain visible.
 */
export async function withdrawContentSession(
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/content-sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function saveSpeakerResource(
  input: {
    id?: string;
    eventId: string;
    title: string;
    slug: string;
    bodyHtml: string;
    embedHtml: string;
    embedAllowedHosts: string[];
    visibility: "hidden" | "visible";
    sortOrder: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(
    input.id ? `/api/speaker-resources/${input.id}` : "/api/speaker-resources",
    {
      method: input.id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        input.id
          ? {
              title: input.title,
              slug: input.slug,
              bodyHtml: input.bodyHtml,
              embedHtml: input.embedHtml,
              embedAllowedHosts: input.embedAllowedHosts,
              visibility: input.visibility,
              sortOrder: input.sortOrder,
            }
          : input,
      ),
    },
  );
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

export async function deleteSpeakerResource(
  resourceId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-resources/${resourceId}`, { method: "DELETE" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

async function contentMutation(
  path: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
  return response;
}

export async function importSpeakerCsv(
  eventId: string,
  csv: string,
  commit: boolean,
  fetcher: typeof fetch = fetch,
) {
  const response = await contentMutation("/api/speaker-imports", { eventId, csv, commit }, fetcher);
  return speakerCsvImportResultSchema.parse(await response.json());
}
export async function updateSpeakerWorkflow(
  profileId: string,
  input: {
    workflowStatus: "invited" | "onboarding" | "ready" | "blocked";
    logistics: Record<string, string>;
    customFields: Record<string, string>;
  },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/speaker-profiles/${profileId}/workflow`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}
export async function bulkRequestSpeakerTasks(
  input: {
    profileIds: string[];
    title: string;
    dueAt: string;
    type: "general" | "file-request";
    instructions: string;
  },
  fetcher: typeof fetch = fetch,
) {
  await contentMutation("/api/speaker-tasks/bulk", input, fetcher);
}
export async function addContentComment(
  assetId: string,
  body: string,
  fetcher: typeof fetch = fetch,
) {
  await contentMutation("/api/content-comments", { assetId, body }, fetcher);
}
export async function restoreContentRevision(revisionId: string, fetcher: typeof fetch = fetch) {
  await contentMutation("/api/content-revisions/restore", { revisionId }, fetcher);
}

/**
 * Send every speaker of every scheduled session the calendar invitation for it.
 *
 * The server decides who is reachable and what was already sent — running this twice on an
 * unchanged agenda writes nothing the second time. `unreachable` names the sessions it could not
 * invite anyone to, because a count gives an organizer nothing to act on.
 */
export async function sendSpeakerCalendarInvites(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher(`/api/events/${eventId}/speaker-calendar-invites`, { method: "POST" }),
    speakerCalendarInviteResultSchema,
  );
}
export async function downloadDeliverables(
  eventId: string,
  assetIds: string[],
  fetcher: typeof fetch = fetch,
) {
  const response = await contentMutation(
    "/api/content-deliverables/bulk-download",
    { eventId, assetIds },
    fetcher,
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "speaker-deliverables.zip";
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function publishSpeakerAsset(
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-assets/${assetId}/publish`, { method: "POST" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

/**
 * Return a published asset to private.
 *
 * The reverse of `publishSpeakerAsset`, and organizer-only for the same reason. A headshot
 * withdrawn this way leaves the public gallery on its next reconciled read, and its bytes stop
 * being served anonymously immediately.
 */
export async function unpublishSpeakerAsset(
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-assets/${assetId}/unpublish`, { method: "POST" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}

/*
 * The event's speaker checklist, from the console (issue #176).
 *
 * Every write here answers with the *whole* checklist rather than the line it touched, and the
 * client returns that rather than reloading: a reorder changes rows the request never named, so
 * a caller reconstructing the order from one row would render an order the server does not hold.
 */
export async function listSpeakerTaskTemplates(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<SpeakerTaskTemplateDto[]> {
  const response = await fetcher(`/api/events/${eventId}/speaker-task-templates`);
  return (await decode(response, speakerTaskTemplateListResponseSchema)).templates;
}

/** Add a line. A title this event already uses is refused rather than converged on. */
export async function createSpeakerTaskTemplate(
  eventId: string,
  input: SpeakerTaskTemplateInput,
  fetcher: typeof fetch = fetch,
): Promise<SpeakerTaskTemplateDto[]> {
  const response = await fetcher(`/api/events/${eventId}/speaker-task-template-entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await decode(response, speakerTaskTemplateListResponseSchema)).templates;
}

/** Edit a line, including its title — the one thing the bulk declaration cannot do. */
export async function updateSpeakerTaskTemplate(
  templateId: string,
  input: SpeakerTaskTemplateInput,
  fetcher: typeof fetch = fetch,
): Promise<SpeakerTaskTemplateDto[]> {
  const response = await fetcher(`/api/speaker-task-templates/${templateId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await decode(response, speakerTaskTemplateListResponseSchema)).templates;
}

/** Remove a line. Tasks already assigned from it are the speakers' and are not touched. */
export async function deleteSpeakerTaskTemplate(
  templateId: string,
  fetcher: typeof fetch = fetch,
): Promise<SpeakerTaskTemplateDto[]> {
  const response = await fetcher(`/api/speaker-task-templates/${templateId}`, { method: "DELETE" });
  return (await decode(response, speakerTaskTemplateListResponseSchema)).templates;
}

/**
 * Instantiate the checklist as real, dated work for the speakers named.
 *
 * Deliberately a separate act from declaring the lines: this is what puts tasks in people's
 * portals and mails them about it. Idempotent per speaker and line, so running it again after a
 * speaker joins brings only the newcomer up to date — and answers only the tasks it created,
 * which is an empty list when there was nothing left to assign.
 */
export async function assignSpeakerChecklist(
  eventId: string,
  profileIds: string[],
  fetcher: typeof fetch = fetch,
): Promise<z.infer<typeof speakerChecklistAssignmentResponseSchema>["tasks"]> {
  const response = await contentMutation(
    `/api/events/${eventId}/speaker-checklist-assignments`,
    { profileIds },
    fetcher,
  );
  return (await decode(response, speakerChecklistAssignmentResponseSchema)).tasks;
}
