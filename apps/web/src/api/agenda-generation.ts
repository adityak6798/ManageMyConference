/**
 * The browser's client for generated agenda drafts, the criteria library and availability.
 *
 * Every call here proposes except `accept`, which is the whole shape of the feature: an organizer
 * generates candidates freely and the board only moves when they say which sessions to move.
 *
 * @spec PRD-AGD-001
 */
import {
  agendaAvailabilityResponseSchema,
  agendaCriteriaResponseSchema,
  agendaDraftAcceptResponseSchema,
  agendaDraftComparisonResponseSchema,
  agendaGeneratedDraftResponseSchema,
  agendaGeneratedDraftsResponseSchema,
  type ApiErrorEnvelope,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class AgendaGenerationApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

const decode = <T>(response: Response, schema: z.ZodType<T>) =>
  decodeResponse(
    response,
    schema,
    (envelope: ApiErrorEnvelope) =>
      new AgendaGenerationApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

const send = (method: "POST" | "PUT", payload: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export type AgendaCriteria = z.infer<typeof agendaCriteriaResponseSchema>;
export type AgendaAvailability = z.infer<typeof agendaAvailabilityResponseSchema>;
export type GeneratedDrafts = z.infer<typeof agendaGeneratedDraftsResponseSchema>;
export type DraftComparison = z.infer<typeof agendaDraftComparisonResponseSchema>;

const base = (eventId: string) => `/api/events/${eventId}/agenda`;

export async function readCriteria(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(`${base(eventId)}/criteria`), agendaCriteriaResponseSchema);
}

export async function saveCriteria(
  eventId: string,
  criteria: readonly { criterion: string; enabled?: boolean }[],
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/criteria`, send("PUT", { criteria })),
    agendaCriteriaResponseSchema,
  );
}

export async function readAvailability(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(`${base(eventId)}/availability`), agendaAvailabilityResponseSchema);
}

export async function listGeneratedDrafts(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher(`${base(eventId)}/generated-drafts`),
    agendaGeneratedDraftsResponseSchema,
  );
}

/** Proposes only. Nothing on the board moves until `acceptDraft`. */
export async function generateDraft(eventId: string, name: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher(`${base(eventId)}/generated-drafts`, send("POST", { name })),
    agendaGeneratedDraftResponseSchema,
  );
}

export async function compareDraft(
  eventId: string,
  draftId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/generated-drafts/${draftId}`),
    agendaDraftComparisonResponseSchema,
  );
}

export async function acceptDraft(
  eventId: string,
  draftId: string,
  sessionIds: readonly string[],
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(
      `${base(eventId)}/generated-drafts/${draftId}/accept`,
      send("POST", { sessionIds }),
    ),
    agendaDraftAcceptResponseSchema,
  );
}

export async function discardDraft(
  eventId: string,
  draftId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${base(eventId)}/generated-drafts/${draftId}`, {
    method: "DELETE",
  });
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new AgendaGenerationApiError(envelope.error.correlationId, envelope.error.message);
}
