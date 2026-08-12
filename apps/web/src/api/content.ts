import {
  type AcceptContentInput,
  acceptContentInputSchema,
  type ContentWorkspaceDto,
  contentWorkspaceSchema,
  setSpeakerPhotoInputSchema,
  type UpdateContentSessionInput,
  type UpdateSpeakerProfileInput,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

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

/** Field-level detail from a handled API failure, keyed by the input path the server named. */
export function contentFieldErrors(error: unknown): Record<string, string[]> {
  return error instanceof ContentApiError ? (error.envelope.error.fieldErrors ?? {}) : {};
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
 * be speaking elsewhere — and the public page keeps the session until the organizer publishes
 * again, because a published snapshot is immutable.
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
  return response.json() as Promise<{
    preview: boolean;
    total: number;
    valid: number;
    imported: number;
    invalid: number;
    duplicates: number;
    rows: { row: number; name: string; email: string; errors: string[] }[];
  }>;
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
 * withdrawn this way leaves the public gallery at the next publish, and its bytes stop being
 * served anonymously immediately.
 */
export async function unpublishSpeakerAsset(
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-assets/${assetId}/unpublish`, { method: "POST" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}
