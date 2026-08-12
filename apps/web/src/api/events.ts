import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  authConfigResponseSchema,
  type CreateEventInput,
  createEventInputSchema,
  createEventResponseSchema,
  demoSessionResponseSchema,
  loginCodeRequestResponseSchema,
  loginCodeVerifyResponseSchema,
  type EventDto,
  eventListResponseSchema,
  type SessionDto,
  sessionResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch } from "./config";

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

export async function getAuthConfig(fetcher: typeof fetch = fetch) {
  const response = await fetcher("/api/auth/config");
  // A stacked frontend may briefly run against the preceding demo-only API while deploys roll.
  if (response.status === 404) return { demoMode: true } as const;
  return decode(response, authConfigResponseSchema);
}

export async function requestLoginCode(email: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher("/api/auth/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    loginCodeRequestResponseSchema,
  );
}

export async function verifyLoginCode(
  challenge: string,
  code: string,
  fetcher: typeof fetch = fetch,
) {
  await decode(
    await fetcher("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, code }),
    }),
    loginCodeVerifyResponseSchema,
  );
}

export async function getSession(fetcher: typeof fetch = fetch): Promise<SessionDto> {
  return decode(await fetcher("/api/session"), sessionResponseSchema);
}

export async function listEvents(fetcher: typeof fetch = fetch): Promise<EventDto[]> {
  const response = await fetcher("/api/events");
  return (await decode(response, eventListResponseSchema)).events;
}
/**
 * The events this session holds a role on, whatever capabilities that role carries.
 *
 * Named for what it is: it requires a session and 401s without one, so it never belonged
 * under `/api/public`.
 */
export async function listAssignedEvents(fetcher: typeof fetch = fetch): Promise<EventDto[]> {
  const response = await fetcher("/api/events/assigned");
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
