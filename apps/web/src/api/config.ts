/**
 * API origin baked into the production bundle by Vite.
 *
 * The empty default preserves the local Vite proxy and same-origin Worker deployment. A
 * separately hosted frontend can instead set `VITE_API_BASE_URL=https://api.example.com`.
 */
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function apiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== "string" || !input.startsWith("/")) return input;
  return `${apiBase}${input}`;
}

/** Fetch through the configured API origin while retaining the native fetch signature. */
export const apiFetch: typeof fetch = (input, init) =>
  init === undefined ? globalThis.fetch(apiUrl(input)) : globalThis.fetch(apiUrl(input), init);

import { apiErrorEnvelopeSchema, type ApiErrorEnvelope } from "@greenroom/contracts";
import type { z } from "zod";

/** A 2xx response that does not match the versioned browser contract. */
export class ResponseContractError extends Error {
  constructor(
    readonly correlationId: string,
    readonly issuePaths: readonly string[],
  ) {
    const paths = issuePaths.length > 0 ? issuePaths.join(", ") : "response";
    super(`The browser could not read the server response (${paths}). Reference: ${correlationId}`);
    this.name = "ResponseContractError";
  }
}

const responseReference = (response: Response) =>
  response.headers.get("x-correlation-id") ?? "unavailable";

/** Decode both halves of an HTTP contract without losing the request's trace reference. */
export async function decodeResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  apiError: (envelope: ApiErrorEnvelope) => Error,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ResponseContractError(responseReference(response), ["response body"]);
  }
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw apiError(parsed.data);
    throw new ResponseContractError(responseReference(response), ["error envelope"]);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ResponseContractError(
      responseReference(response),
      parsed.error.issues.map(({ path }) => (path.length > 0 ? path.join(".") : "response")),
    );
  return parsed.data;
}
