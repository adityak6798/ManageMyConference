import {
  type ApiErrorEnvelope,
  type CommunicationsHistoryDto,
  communicationsHistoryResponseSchema,
  deliveryResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class CommunicationsApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new CommunicationsApiError(envelope));
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
