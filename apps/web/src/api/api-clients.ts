/** Browser client for organization-scoped machine credentials. */
import {
  type ApiErrorEnvelope,
  apiClientsResponseSchema,
  createApiClientResponseSchema,
  rotateApiClientResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ApiClientsApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

const decode = <T>(response: Response, schema: z.ZodType<T>) =>
  decodeResponse(response, schema, (envelope) => new ApiClientsApiError(envelope));

export type ApiClientDto = z.infer<typeof apiClientsResponseSchema>["clients"][number];

export function listApiClients(organizationId: string, fetcher: typeof fetch = fetch) {
  return fetcher(`/api/organizations/${organizationId}/api-clients`).then((response) =>
    decode(response, apiClientsResponseSchema),
  );
}

export function createApiClient(
  organizationId: string,
  command: { name: string; scopes: string[]; eventIds: string[]; expiresAt?: string },
  fetcher: typeof fetch = fetch,
) {
  return fetcher(`/api/organizations/${organizationId}/api-clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }).then((response) => decode(response, createApiClientResponseSchema));
}

export function rotateApiClient(
  organizationId: string,
  clientId: string,
  fetcher: typeof fetch = fetch,
) {
  return fetcher(`/api/organizations/${organizationId}/api-clients/${clientId}/rotate`, {
    method: "POST",
  }).then((response) => decode(response, rotateApiClientResponseSchema));
}

export async function revokeApiClient(
  organizationId: string,
  clientId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/organizations/${organizationId}/api-clients/${clientId}`, {
    method: "DELETE",
  });
  if (!response.ok) await decode(response, apiClientsResponseSchema); // Always throws through the envelope path.
}
