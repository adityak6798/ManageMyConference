import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  type CreateEventInput,
  type AcceptContentInput,
  type ContentWorkspaceDto,
  createEventInputSchema,
  createEventResponseSchema,
  demoSessionResponseSchema,
  type EventDto,
  eventListResponseSchema,
  type SessionDto,
  sessionResponseSchema,
  contentWorkspaceSchema,
  updateSpeakerProfileInputSchema,
  type UpdateSpeakerProfileInput,
} from "@greenroom/contracts";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new ApiError(parsed.data);
    throw new Error(`API failed with status ${response.status} and an invalid error response`);
  }
  return schema.parse(body);
}

export async function startDemoSession(
  persona: "organizer" | "reviewer" | "speaker" | "public",
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/demo-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  await decode(response, demoSessionResponseSchema);
}

export async function getSession(fetcher: typeof fetch = fetch): Promise<SessionDto> {
  return decode(await fetcher("/api/session"), sessionResponseSchema);
}

export async function listEvents(fetcher: typeof fetch = fetch): Promise<EventDto[]> {
  const response = await fetcher("/api/events");
  return (await decode(response, eventListResponseSchema)).events;
}

export async function createEvent(
  input: CreateEventInput,
  fetcher: typeof fetch = fetch,
): Promise<EventDto> {
  const validated = createEventInputSchema.parse(input);
  const response = await fetcher("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });
  return (await decode(response, createEventResponseSchema)).event;
}

export async function getContent(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<ContentWorkspaceDto> {
  return decode(await fetcher(`/api/events/${eventId}/content`), contentWorkspaceSchema);
}
export async function acceptContent(
  eventId: string,
  input: AcceptContentInput,
  fetcher: typeof fetch = fetch,
): Promise<ContentWorkspaceDto> {
  return decode(
    await fetcher(`/api/events/${eventId}/content/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    contentWorkspaceSchema,
  );
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
    visibility: "private" | "publishable";
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
