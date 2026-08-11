import {
  apiErrorEnvelopeSchema,
  type PublicEventProjectionDto,
  publicationPreviewResponseSchema,
  publicEventResponseSchema,
} from "@greenroom/contracts";

export class PublicApiError extends Error {}

/**
 * The event's public slug and publication state.
 *
 * The console links out to the public site, and the slug is server-assigned — deriving
 * it from the event name would send organizers of a second event to the first event's
 * page. Returns null when the caller cannot see the publication.
 */
export async function getPublicationSummary(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ slug: string; state: string } | null> {
  const response = await fetcher(`/api/publishing/events/${encodeURIComponent(eventId)}/preview`);
  if (!response.ok) return null;
  const parsed = publicationPreviewResponseSchema.safeParse(await response.json());
  if (!parsed.success) return null;
  return { slug: parsed.data.publication.slug, state: parsed.data.publication.state };
}

// @spec PRD-PUB-001
export async function getPublicEvent(
  slug: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicEventProjectionDto> {
  const response = await fetcher(`/api/public/events/${encodeURIComponent(slug)}`);
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new PublicApiError(parsed.data.error.message);
    throw new Error("The public event could not be loaded");
  }
  return publicEventResponseSchema.parse(body).projection;
}
