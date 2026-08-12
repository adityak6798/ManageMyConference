/*
 * Attendee itineraries.
 *
 * The identity here is a capability token, not a session. `/api/public/*` answers every
 * origin with `Access-Control-Allow-Origin: *` and browsers refuse to send credentials to a
 * wildcard origin, so a cookie could not identify an attendee on an embedded page even if
 * one existed. The token is minted by the server, kept in `localStorage`, and put in the
 * path — which is also what makes the namespace's shared ETag cache correct, since each
 * itinerary is then its own URL rather than a per-attendee body on a shared one.
 */
import {
  type ItineraryDto,
  itineraryCreatedResponseSchema,
  itineraryResponseSchema,
} from "@greenroom/contracts";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ItineraryApiError extends Error {}

const failure = (message: string) => () => new ItineraryApiError(message);

// @spec PRD-PUB-001
export async function createItinerary(
  eventSlug: string,
  sessionSlugs: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<{ token: string; itinerary: ItineraryDto }> {
  return decodeResponse(
    await fetcher(`/api/public/events/${encodeURIComponent(eventSlug)}/itinerary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionSlugs: [...sessionSlugs] }),
    }),
    itineraryCreatedResponseSchema,
    failure("This itinerary could not be started."),
  );
}

// @spec PRD-PUB-001
export async function readItinerary(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<ItineraryDto> {
  return (
    await decodeResponse(
      await fetcher(`/api/public/itineraries/${encodeURIComponent(token)}`),
      itineraryResponseSchema,
      failure("This itinerary could not be read."),
    )
  ).itinerary;
}

/** Replaces the stored list outright — there is no add or remove verb. */
// @spec PRD-PUB-001
export async function saveItinerary(
  token: string,
  sessionSlugs: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<ItineraryDto> {
  return (
    await decodeResponse(
      await fetcher(`/api/public/itineraries/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionSlugs: [...sessionSlugs] }),
      }),
      itineraryResponseSchema,
      failure("This itinerary could not be saved."),
    )
  ).itinerary;
}
