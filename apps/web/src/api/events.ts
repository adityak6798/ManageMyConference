import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  type CreateEventInput,
  createEventInputSchema,
  createEventResponseSchema,
  demoSessionResponseSchema,
  type EventDto,
  eventListResponseSchema,
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
  persona: "organizer" | "reviewer" | "speaker",
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/demo-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  await decode(response, demoSessionResponseSchema);
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
