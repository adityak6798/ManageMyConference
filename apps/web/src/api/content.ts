import {
  type AcceptContentInput,
  acceptContentInputSchema,
  apiErrorEnvelopeSchema,
  type ContentWorkspaceDto,
  contentWorkspaceSchema,
  type UpdateContentSessionInput,
  type UpdateSpeakerProfileInput,
  updateContentSessionInputSchema,
  updateSpeakerProfileInputSchema,
} from "@greenroom/contracts";
import type { z } from "zod";

export class ContentApiError extends Error {
  constructor(readonly envelope: import("@greenroom/contracts").ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new ContentApiError(parsed.data);
    throw new Error(`Content API failed with status ${response.status}`);
  }
  return schema.parse(body);
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

export async function publishSpeakerAsset(
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/speaker-assets/${assetId}/publish`, { method: "POST" });
  if (!response.ok) await decode(response, contentWorkspaceSchema);
}
