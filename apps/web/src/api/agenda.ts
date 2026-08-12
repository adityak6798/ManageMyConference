import {
  type AgendaAssistedDraftDto,
  type AgendaDraftDto,
  type ApiErrorEnvelope,
  agendaAssistedDraftSchema,
  agendaDraftSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
  publishedScheduleSchema,
} from "@greenroom/contracts";
import { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class AgendaApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new AgendaApiError(envelope));
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

/**
 * Ask the API to seat the unscheduled sessions, or the named subset of them.
 *
 * One request for the whole pass. Sending a placement per session would put the round-trip
 * cost back that issue #69 removed, and would let the board show a half-generated draft.
 */
export async function autoPlaceSessions(
  eventId: string,
  sessionIds: readonly string[] | undefined,
  fetcher: typeof fetch = fetch,
): Promise<AgendaAssistedDraftDto> {
  const response = await fetcher(`/api/events/${eventId}/agenda/assisted-placements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionIds?.length ? { sessionIds } : {}),
  });
  return (await decode(response, z.object({ agenda: agendaAssistedDraftSchema }))).agenda;
}

export async function publishAgenda(eventId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/events/${eventId}/agenda/publications`, { method: "POST" });
  return (await decode(response, z.object({ schedule: publishedScheduleSchema }))).schedule;
}
