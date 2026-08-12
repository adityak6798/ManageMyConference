import {
  type ApiErrorEnvelope,
  type OrganizerOverviewDto,
  organizerOverviewResponseSchema,
} from "@greenroom/contracts";
import { apiFetch as fetch, decodeResponse } from "./config";

class OverviewApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

export interface OrganizerOverviewResult {
  readonly data: OrganizerOverviewDto;
  readonly fetchedAt: number;
}

const cache = new Map<string, Promise<OrganizerOverviewResult>>();

/** One cached event composition; explicit refreshes replace the cached promise. */
export async function getOrganizerOverview(
  eventId: string,
  options: { refresh?: boolean; fetcher?: typeof fetch } = {},
): Promise<OrganizerOverviewResult> {
  const fetcher = options.fetcher ?? fetch;
  const current = cache.get(eventId);
  if (current && !options.refresh) return current;
  const request = fetcher(`/api/events/${eventId}/overview`).then(async (response) => ({
    data: await decodeResponse(
      response,
      organizerOverviewResponseSchema,
      (envelope: ApiErrorEnvelope) => new OverviewApiError(envelope),
    ),
    fetchedAt: Date.now(),
  }));
  cache.set(eventId, request);
  // ERROR-INTENT: eviction is the recovery consequence; the caller still owns and observes
  // the original rejected promise, while the next mount is allowed to retry it.
  request.catch(() => {
    // ERROR-INTENT: eviction is the recovery consequence; the caller still owns and observes
    // the original rejected promise, while the next mount is allowed to retry it.
    if (cache.get(eventId) === request) cache.delete(eventId);
  });
  return request;
}

export function clearOrganizerOverviewCache() {
  cache.clear();
}
