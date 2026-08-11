import {
  apiErrorEnvelopeSchema,
  type PublicEventProjectionDto,
  publicEventResponseSchema,
} from "@greenroom/contracts";

export class PublicApiError extends Error {}

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
