/**
 * The browser's client for outbound webhook subscriptions.
 *
 * **This existed on the server and nowhere else.** Seven routes, a D1 adapter, a retry ladder, a
 * secret-rotation overlap and an idempotent replay — all built, all tested, and unreachable by
 * anybody using the product. That is the ninth recorded instance of the pattern this repository
 * keeps finding (#145, #149, #163, #206, and three more in PR #219's own sweep), and every one of
 * them was found by a person clicking rather than by a gate.
 *
 * Addressed by organization, matching the routes: a subscription may be scoped to one event or to
 * the whole organization, and the organization is where the access is authorized either way.
 *
 * @spec PRD-INT-001
 */
import {
  type ApiErrorEnvelope,
  createWebhookResponseSchema,
  rotateWebhookResponseSchema,
  webhookDeliveryResponseSchema,
  webhookHistoryResponseSchema,
  webhookResponseSchema,
  webhooksResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class WebhookApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
    /**
     * Carried because `WEBHOOK_UNAVAILABLE` is not a failure. It means this deployment has no
     * egress configuration, which is a fact about the environment rather than about the request,
     * and the screen says so instead of raising an alert nobody can act on.
     */
    readonly code: string = "INTERNAL_ERROR",
  ) {
    super(message);
  }
}

const decode = <T>(response: Response, schema: z.ZodType<T>) =>
  decodeResponse(
    response,
    schema,
    (envelope: ApiErrorEnvelope) =>
      new WebhookApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
        envelope.error.code,
      ),
  );

const send = (method: "POST" | "PATCH", payload?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

export type WebhooksResponse = z.infer<typeof webhooksResponseSchema>;
export type WebhookHistory = z.infer<typeof webhookHistoryResponseSchema>;
export type WebhookCreated = z.infer<typeof createWebhookResponseSchema>;
export type WebhookRotated = z.infer<typeof rotateWebhookResponseSchema>;

const base = (organizationId: string) => `/api/organizations/${organizationId}/webhooks`;

export async function listWebhooks(organizationId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(organizationId)), webhooksResponseSchema);
}

/** The signing secret is returned once, on creation. Nothing can reissue it — only rotate it. */
export async function createWebhook(
  organizationId: string,
  input: { url: string; eventTypes: readonly string[]; eventId?: string | null },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(base(organizationId), send("POST", input)),
    createWebhookResponseSchema,
  );
}

export async function updateWebhook(
  organizationId: string,
  subscriptionId: string,
  input: { url?: string; eventTypes?: readonly string[]; eventId?: string | null },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${subscriptionId}`, send("PATCH", input)),
    webhookResponseSchema,
  );
}

export async function deleteWebhook(
  organizationId: string,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${base(organizationId)}/${subscriptionId}`, {
    method: "DELETE",
  });
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new WebhookApiError(
    envelope.error.correlationId,
    envelope.error.message,
    envelope.error.fieldErrors ?? {},
    envelope.error.code,
  );
}

/**
 * Rotate the signing secret, answering the new one and when the old one stops being accepted.
 *
 * The overlap is the whole point of rotation rather than replacement: a receiver keeps verifying
 * with the old secret until it has deployed the new one.
 */
export async function rotateWebhookSecret(
  organizationId: string,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${subscriptionId}/rotate-secret`, send("POST")),
    rotateWebhookResponseSchema,
  );
}

export async function listWebhookDeliveries(
  organizationId: string,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${subscriptionId}/deliveries`),
    webhookHistoryResponseSchema,
  );
}

/** Replay one delivery. Idempotent at the receiver, because the key travels with the payload. */
export async function replayWebhookDelivery(
  organizationId: string,
  deliveryId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(
      `/api/organizations/${organizationId}/webhook-deliveries/${deliveryId}/replay`,
      send("POST"),
    ),
    webhookDeliveryResponseSchema,
  );
}
