/*
 * The events domain's browser client.
 *
 * `/api/session`, `/api/auth/*` and `/api/demo-session` used to be answered from here, because
 * the console needed them and the console's first client happened to be this one. They are
 * identity's endpoints and now live in `api/identity.ts`, where a surface that is not the
 * console can reach them without importing this domain to do it.
 */
import {
  type ApiErrorEnvelope,
  type CreateEventInput,
  createEventInputSchema,
  createEventResponseSchema,
  type EventDto,
  eventListResponseSchema,
  type UpdateEventInput,
  updateEventInputSchema,
  updateEventResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new ApiError(envelope));
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
  idempotencyKey?: string,
  fetcher: typeof fetch = fetch,
): Promise<EventDto> {
  const validated = createEventInputSchema.parse(input);
  const response = await fetcher("/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(validated),
  });
  return (await decode(response, createEventResponseSchema)).event;
}

export async function updateEvent(
  eventId: string,
  input: UpdateEventInput,
  fetcher: typeof fetch = fetch,
): Promise<EventDto> {
  const validated = updateEventInputSchema.parse(input);
  const response = await fetcher(`/api/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });
  return (await decode(response, updateEventResponseSchema)).event;
}
