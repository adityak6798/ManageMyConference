import {
  type ApiErrorEnvelope,
  type BroadcastResultDto,
  type CommunicationsHistoryDto,
  type CreateTemplateInput,
  type MessageTemplateDto,
  broadcastRecipientsResponseSchema,
  broadcastResponseSchema,
  communicationsHistoryResponseSchema,
  deliveryResponseSchema,
  templateListResponseSchema,
  templateResponseSchema,
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

export async function getTemplates(
  organizationId: string,
  fetcher: typeof fetch = fetch,
): Promise<MessageTemplateDto[]> {
  const query = new URLSearchParams({ organizationId });
  const response = await fetcher(`/api/communications/templates?${query}`);
  return (await decode(response, templateListResponseSchema)).templates;
}

export async function createTemplate(
  input: CreateTemplateInput,
  fetcher: typeof fetch = fetch,
): Promise<MessageTemplateDto> {
  const response = await fetcher("/api/communications/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await decode(response, templateResponseSchema)).template;
}

/**
 * Who a send would reach, so the organizer confirms against a count rather than a promise.
 *
 * Returns the audience's version as well as its members. Carrying that back on the send is what
 * stops a speaker added between the count and the confirmation from receiving a message under a
 * count nobody approved.
 */
export async function getRecipients(
  organizationId: string,
  eventId: string,
  fetcher: typeof fetch = fetch,
) {
  const query = new URLSearchParams({ organizationId, eventId });
  const response = await fetcher(`/api/communications/recipients?${query}`);
  return decode(response, broadcastRecipientsResponseSchema);
}

export async function sendToSpeakers(
  input: {
    organizationId: string;
    eventId: string;
    templateKey: string;
    templateVersion: number;
    audienceVersion?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<BroadcastResultDto> {
  const response = await fetcher("/api/communications/broadcasts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return decode(response, broadcastResponseSchema);
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
