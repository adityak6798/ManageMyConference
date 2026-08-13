/**
 * The browser client for platform's cross-domain operational reads.
 *
 * Deliberately uncached, unlike `api/overview.ts`. The overview asks one question per event and
 * every mount asks it again, so a promise cache is the difference between one request and four.
 * Search asks a different question on every keystroke: a cache keyed by the query would hold a
 * separate entry for every prefix the operator typed on the way to the word they wanted, and
 * serving any of them later would answer a live surface with a snapshot of an event that has
 * since moved. What search needs instead is that a late answer to an abandoned keystroke never
 * paints, and that is the caller's ordering problem — see `CommandPalette`.
 */
import {
  type ApiErrorEnvelope,
  type SearchResponseDto,
  searchResponseSchema,
} from "@greenroom/contracts";
import { apiFetch as fetch, decodeResponse } from "./config";

export class PlatformApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
    this.name = "PlatformApiError";
  }
}

export interface SearchOptions {
  limit?: number;
  /** Aborted by the caller when a newer keystroke supersedes this request. */
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export async function searchEvent(
  eventId: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponseDto> {
  const fetcher = options.fetcher ?? fetch;
  const parameters = new URLSearchParams({ q: query });
  if (options.limit !== undefined) parameters.set("limit", String(options.limit));
  const response = await fetcher(
    `/api/events/${encodeURIComponent(eventId)}/search?${parameters.toString()}`,
    options.signal ? { signal: options.signal } : {},
  );
  return decodeResponse(
    response,
    searchResponseSchema,
    (envelope: ApiErrorEnvelope) => new PlatformApiError(envelope),
  );
}
