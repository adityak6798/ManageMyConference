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
  apiErrorEnvelopeSchema,
  type AuditResponseDto,
  auditResponseSchema,
  type InboxDismissalDto,
  inboxDismissalResponseSchema,
  type InboxResponseDto,
  inboxResponseSchema,
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

export function getInbox(
  eventId: string,
  options: { fetcher?: typeof fetch } = {},
): Promise<InboxResponseDto> {
  const fetcher = options.fetcher ?? fetch;
  return fetcher(`/api/events/${encodeURIComponent(eventId)}/inbox`).then((response) =>
    decodeResponse(
      response,
      inboxResponseSchema,
      (envelope: ApiErrorEnvelope) => new PlatformApiError(envelope),
    ),
  );
}

/**
 * A response with nothing to decode.
 *
 * `decodeResponse` reads a body and 204 has none, so parsing it would fail on the *successful*
 * path. A refusal still carries the standard envelope, which is the only half read here.
 */
async function expectNoContent(response: Response): Promise<void> {
  if (response.ok) return;
  // ERROR-INTENT: a refusal whose body is not JSON is reported as the contract failure below,
  // rather than being allowed to reject with a parse error that names no reference.
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) throw new PlatformApiError(parsed.data);
  throw new Error("The browser could not read the server response.");
}

/**
 * Records the dismissal and decodes what the server says it stored.
 *
 * The 201 body goes through `decodeResponse` like every other response in this client, rather
 * than being discarded: `inboxDismissalResponseSchema` is the contract for it, and a schema with
 * no client that reads it is a contract nothing checks.
 */
export async function dismissInboxItem(
  eventId: string,
  itemKey: string,
  options: { fetcher?: typeof fetch } = {},
): Promise<InboxDismissalDto> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`/api/events/${encodeURIComponent(eventId)}/inbox/dismissals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemKey }),
  });
  return (
    await decodeResponse(
      response,
      inboxDismissalResponseSchema,
      (envelope: ApiErrorEnvelope) => new PlatformApiError(envelope),
    )
  ).dismissal;
}

export async function restoreInboxItem(
  eventId: string,
  itemKey: string,
  options: { fetcher?: typeof fetch } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  await expectNoContent(
    await fetcher(
      `/api/events/${encodeURIComponent(eventId)}/inbox/dismissals/${encodeURIComponent(itemKey)}`,
      { method: "DELETE" },
    ),
  );
}

export function getAuditTimeline(
  eventId: string,
  options: { cursor?: string; limit?: number; fetcher?: typeof fetch } = {},
): Promise<AuditResponseDto> {
  const fetcher = options.fetcher ?? fetch;
  const parameters = new URLSearchParams();
  if (options.cursor) parameters.set("cursor", options.cursor);
  if (options.limit !== undefined) parameters.set("limit", String(options.limit));
  const query = parameters.toString();
  return fetcher(
    `/api/events/${encodeURIComponent(eventId)}/audit${query ? `?${query}` : ""}`,
  ).then((response) =>
    decodeResponse(
      response,
      auditResponseSchema,
      (envelope: ApiErrorEnvelope) => new PlatformApiError(envelope),
    ),
  );
}
