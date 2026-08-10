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
  fetcher: typeof fetch = fetch,
): Promise<CommunicationsHistoryDto["history"]> {
  const query = new URLSearchParams({ organizationId, eventId });
  const response = await fetcher(`/api/communications/history?${query}`);
  return (await decode(response, communicationsHistoryResponseSchema)).history;
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
