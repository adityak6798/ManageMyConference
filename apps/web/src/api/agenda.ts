import {
  type AgendaDraftDto,
  type ApiErrorEnvelope,
  agendaDraftSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  apiErrorEnvelopeSchema,
  publishedScheduleSchema,
} from "@greenroom/contracts";
import { z } from "zod";
import { apiFetch as fetch } from "./config";

export class AgendaApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new AgendaApiError(parsed.data);
    throw new Error(`API failed with status ${response.status} and an invalid error response`);
  }
  return schema.parse(body);
}

export async function getAgenda(eventId: string, fetcher: typeof fetch = fetch) {
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/agenda`),
      z.object({ agenda: agendaDraftSchema }),
    )
  ).agenda;
}

export async function savePlacement(
  eventId: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<AgendaDraftDto> {
  const placement = agendaPlacementSchema.parse(input);
  const response = await fetcher(`/api/events/${eventId}/agenda/placements/${placement.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(placement),
  });
  return (await decode(response, z.object({ agenda: agendaDraftSchema }))).agenda;
}

export async function saveAgendaResources(
  eventId: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<AgendaDraftDto> {
  const resources = agendaResourcesSchema.parse(input);
  const response = await fetcher(`/api/events/${eventId}/agenda/resources`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(resources),
  });
  return (await decode(response, z.object({ agenda: agendaDraftSchema }))).agenda;
}

export async function removePlacement(
  eventId: string,
  placementId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/events/${eventId}/agenda/placements/${placementId}`, {
    method: "DELETE",
  });
  if (!response.ok) await decode(response, agendaDraftSchema);
}

export async function publishAgenda(eventId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/events/${eventId}/agenda/publications`, { method: "POST" });
  return (await decode(response, z.object({ schedule: publishedScheduleSchema }))).schedule;
}
