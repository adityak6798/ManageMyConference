import {
  type ApiErrorEnvelope,
  type PublicEventProjectionDto,
  publicationPreviewResponseSchema,
  publicEventResponseSchema,
} from "@greenroom/contracts";
import { apiFetch as fetch, decodeResponse } from "./config";

export class PublicApiError extends Error {}

/** A publishing failure that still carries the server's correlation reference. */
export class PublicationApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

/**
 * The organizer-visible publication record: the composed draft, the immutable
 * snapshot the public is being served, and when that snapshot was taken.
 */
export type PublicationDto = ReturnType<
  typeof publicationPreviewResponseSchema.parse
>["publication"];

async function decodePublication(response: Response): Promise<PublicationDto> {
  return (
    await decodeResponse(
      response,
      publicationPreviewResponseSchema,
      (envelope) => new PublicationApiError(envelope),
    )
  ).publication;
}

/**
 * Compose the publication payload without publishing it.
 *
 * The server rebuilds `draft` from the live content, agenda, and CFP on every call,
 * so this is the only honest way to answer "what would publishing produce right now"
 * — and it never touches the snapshot the public is being served.
 */
// @spec PRD-PUB-001
export async function previewPublication(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicationDto> {
  return decodePublication(
    await fetcher(`/api/publishing/events/${encodeURIComponent(eventId)}/preview`),
  );
}

/** Promote the composed draft to the public snapshot, or take the public page down. */
// @spec PRD-PUB-001
export async function setPublicationState(
  eventId: string,
  action: "publish" | "unpublish",
  fetcher: typeof fetch = fetch,
): Promise<PublicationDto> {
  return decodePublication(
    await fetcher(`/api/publishing/events/${encodeURIComponent(eventId)}/${action}`, {
      method: "POST",
    }),
  );
}

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
  try {
    const publication = await previewPublication(eventId, fetcher);
    return { slug: publication.slug, state: publication.state };
  } catch {
    // ERROR-INTENT: this only decides whether an outbound convenience link is offered.
    // A network failure, a refusal, or a non-JSON body must resolve to "unknown", never
    // reject — an unhandled rejection here would surface as a page error in the console.
    return null;
  }
}

// @spec PRD-PUB-001
export async function getPublicEvent(
  slug: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicEventProjectionDto> {
  const response = await fetcher(`/api/public/events/${encodeURIComponent(slug)}`);
  return (
    await decodeResponse(
      response,
      publicEventResponseSchema,
      (envelope) => new PublicApiError(envelope.error.message),
    )
  ).projection;
}
