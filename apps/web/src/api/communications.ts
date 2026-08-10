import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  type CommunicationsHistoryDto,
  communicationsHistoryResponseSchema,
  deliveryResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";

export class CommunicationsApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw new CommunicationsApiError(parsed.data);
    throw new Error(`Communications API failed with status ${response.status}`);
  }
  return schema.parse(body);
}

export async function getCommunicationsHistory(
  organizationId: string,
  eventId: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<CommunicationsHistoryDto> {
  const query = new URLSearchParams({ organizationId, eventId, limit: "25" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetcher(`/api/communications/history?${query}`);
  return decode(response, communicationsHistoryResponseSchema);
}

export async function retryDelivery(
  organizationId: string,
  deliveryId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const query = new URLSearchParams({ organizationId });
  await decode(
    await fetcher(
      `/api/communications/deliveries/${encodeURIComponent(deliveryId)}/retry?${query}`,
      {
        method: "POST",
      },
    ),
    deliveryResponseSchema,
  );
}
