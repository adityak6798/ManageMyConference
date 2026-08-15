/**
 * The browser's client for named, revocable embeds.
 *
 * Event-addressed, matching the routes. The URL an embed answers at comes back from the server
 * once — only the digest is stored — so this module never assembles one.
 *
 * @spec PRD-PUB-001
 */
import {
  type ApiErrorEnvelope,
  embedCreatedResponseSchema,
  embedResponseSchema,
  embedsResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class EmbedApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

const decode = <T>(response: Response, schema: z.ZodType<T>) =>
  decodeResponse(
    response,
    schema,
    (envelope: ApiErrorEnvelope) =>
      new EmbedApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

const body = (method: "POST" | "PUT", payload: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export type EmbedsResponse = z.infer<typeof embedsResponseSchema>;
export type EmbedCreated = z.infer<typeof embedCreatedResponseSchema>;

const base = (eventId: string) => `/api/publishing/events/${eventId}/embeds`;

export async function listEmbeds(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(eventId)), embedsResponseSchema);
}

export async function createEmbed(eventId: string, draft: unknown, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(eventId), body("POST", draft)), embedCreatedResponseSchema);
}

export async function updateEmbed(
  eventId: string,
  embedId: string,
  draft: unknown,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/${embedId}`, body("PUT", draft)),
    embedResponseSchema,
  );
}

/** The one way to change an output type; the old address keeps working until it is withdrawn. */
export async function duplicateEmbed(
  eventId: string,
  embedId: string,
  changes: { name: string; output?: string },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/${embedId}/duplicate`, body("POST", changes)),
    embedCreatedResponseSchema,
  );
}

export async function revokeEmbed(eventId: string, embedId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${base(eventId)}/${embedId}`, { method: "DELETE" });
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new EmbedApiError(envelope.error.correlationId, envelope.error.message);
}
